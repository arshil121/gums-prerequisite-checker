// ==UserScript==
// @name         GUMS Prerequisite Checker
// @namespace    https://green.edu.bd/
// @version      1.0.0
// @description  Advisor-side prerequisite validation dashboard for GUMS registration
// @author       Md. Shoab Alam
// @homepageURL  https://github.com/arshil121/gums-prerequisite-checker
// @supportURL   https://github.com/arshil121/gums-prerequisite-checker/issues
// @updateURL    https://raw.githubusercontent.com/arshil121/gums-prerequisite-checker/main/gums-prerequisite-checker.user.js
// @downloadURL  https://raw.githubusercontent.com/arshil121/gums-prerequisite-checker/main/gums-prerequisite-checker.user.js
// @match        https://gums.green.edu.bd/Registration/Registration.aspx*
// @match        https://gums.green.edu.bd/Student/StudentCourseHistory.aspx*
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  // ============================================================
  // CONFIG
  // ============================================================
  const SOURCE_URL = 'https://github.com/arshil121/gums-prerequisite-checker';
  const NON_PASSING_GRADES = new Set(['F', 'I', 'W', 'AB', '']);
  const HISTORY_CACHE_PREFIX = 'gums_completed_cache_';   // + roll number
  const HISTORY_CACHE_MAX_AGE_MS = 1000 * 60 * 60 * 6;     // 6 hours

  // Remedial ("Pre-Course") requirements — one-time imported list of students
  // who were flagged as needing EAP009 (Pre-English) and/or MAT009 (Pre-Math)
  // at admission. Course codes on the actual completed-course records are
  // matched against these via the same normalize()/extractBaseCourseCode()
  // logic used everywhere else, so "EAP 009-..." etc. still matches.
  const REMEDIAL_COURSES = [
    { key: 'preEnglish', code: 'EAP009', label: 'Pre-English (EAP009)' },
    { key: 'preMath', code: 'MAT009', label: 'Pre-Math (MAT009)' }
  ];

  // Special course validation rules
  const SPECIAL_RULES = {
    'CSE400A': {
      minCredits: 100,
      description: 'CSE 400a requires at least 100 completed credits'
    },
    'CSE300B': {
      requiredCourses: ['CSE400A'],
      description: 'CSE 300b requires CSE 400a to be completed or in progress'
    },
    'CSE400C': {
      requiredCourses: ['CSE400A', 'CSE400B'],
      description: 'CSE 400c requires both CSE 400a and CSE 400b to be completed or in progress'
    }
  };

  // Minimal RFC4180-style CSV line parser — handles quoted fields that
  // contain commas, escaped double-quotes (""), and surrounding whitespace.
  // Plain split(',') breaks whenever a field (e.g. a course title) contains a comma.
  function parseCSVLine(line) {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }
          else { inQuotes = false; }
        } else {
          cur += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',') {
        out.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur.trim());
    return out;
  }

  // Quote a field for CSV output if it contains a comma, quote, or newline.
  function csvField(val) {
    const s = val == null ? '' : String(val);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  // ============================================================
  // STORAGE MANAGER (prerequisite rules + prefs, one-time input)
  // ============================================================
  const StorageManager = (() => {
    const RULES_KEY = 'gums_prerequisite_rules';
    const PREFS_KEY = 'gums_ui_prefs';

    function normalize(code) {
      // Route through the same base-code stripping used for DOM-extracted
      // course codes, so a rule entered as "CSE 103-CSE(181)" matches a
      // completed course extracted as "CSE103". Previously this only
      // stripped spaces/dashes, which left mismatched suffixes like
      // "CSE(181)" in place and silently broke every rule that used them.
      return extractBaseCourseCode(code);
    }

    function loadRules() {
      try {
        const raw = localStorage.getItem(RULES_KEY);
        return raw ? JSON.parse(raw) : [];
      } catch (e) {
        console.error('[GUMS] Failed to load rules, resetting.', e);
        return [];
      }
    }
    function saveRules(rules) {
      try {
        localStorage.setItem(RULES_KEY, JSON.stringify(rules));
      } catch (e) {
        console.error('[GUMS] Failed to save rules to localStorage.', e);
        alert('Could not save the rule — your browser blocked local storage on this page (' + e.message + ').');
        throw e;
      }
    }

    function addRule(courseCode, courseTitle, prereqCode, prereqTitle) {
      const rules = loadRules();
      const exists = rules.some(r => normalize(r.courseCode) === normalize(courseCode) && normalize(r.prereqCode) === normalize(prereqCode));
      if (exists) { alert('That rule already exists.'); return rules; }
      rules.push({ courseCode, courseTitle, prereqCode, prereqTitle });
      saveRules(rules);
      return rules;
    }
    function deleteRule(courseCode, prereqCode) {
      const rules = loadRules().filter(r => !(normalize(r.courseCode) === normalize(courseCode) && normalize(r.prereqCode) === normalize(prereqCode)));
      saveRules(rules);
      return rules;
    }
    function loadPrefs() { try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || { theme: 'light' }; } catch { return { theme: 'light' }; } }
    function savePrefs(prefs) { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); }

    function importCSV(csvText) {
      const lines = csvText.split(/\r?\n/).filter(l => l.trim().length > 0);
      if (lines.length < 2) return { added: 0, errors: ['CSV appears empty or header-only.'] };
      const header = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase());
      const idx = { code: header.indexOf('course_code'), title: header.indexOf('course_title'), pcode: header.indexOf('prerequisite_code'), ptitle: header.indexOf('prerequisite_title') };
      if (idx.code === -1 || idx.pcode === -1) return { added: 0, errors: ['CSV must include course_code and prerequisite_code columns.'] };
      let rules = loadRules(); let added = 0; const errors = [];
      for (let i = 1; i < lines.length; i++) {
        const cols = parseCSVLine(lines[i]);
        const courseCode = cols[idx.code], prereqCode = cols[idx.pcode];
        if (!courseCode || !prereqCode) { errors.push(`Row ${i + 1}: missing required field, skipped.`); continue; }
        const courseTitle = idx.title !== -1 ? cols[idx.title] : '';
        const prereqTitle = idx.ptitle !== -1 ? cols[idx.ptitle] : '';
        const exists = rules.some(r => normalize(r.courseCode) === normalize(courseCode) && normalize(r.prereqCode) === normalize(prereqCode));
        if (!exists) { rules.push({ courseCode, courseTitle, prereqCode, prereqTitle }); added++; }
      }
      saveRules(rules);
      return { added, errors, total: rules.length };
    }
    function exportCSV() {
      const rules = loadRules();
      const rows = rules.map(r => [r.courseCode, r.courseTitle, r.prereqCode, r.prereqTitle].map(csvField).join(','));
      return ['course_code,course_title,prerequisite_code,prerequisite_title', ...rows].join('\n');
    }
    function exportJSON() { return JSON.stringify(loadRules(), null, 2); }
    function importJSON(jsonText) {
      let parsed;
      try { parsed = JSON.parse(jsonText); } catch (e) { return { added: 0, errors: ['Invalid JSON: ' + e.message] }; }
      if (!Array.isArray(parsed)) return { added: 0, errors: ['JSON must be an array of rule objects.'] };
      let rules = loadRules(); let added = 0;
      parsed.forEach(r => {
        if (!r.courseCode || !r.prereqCode) return;
        const exists = rules.some(x => normalize(x.courseCode) === normalize(r.courseCode) && normalize(x.prereqCode) === normalize(r.prereqCode));
        if (!exists) { rules.push({ courseCode: r.courseCode, courseTitle: r.courseTitle || '', prereqCode: r.prereqCode, prereqTitle: r.prereqTitle || '' }); added++; }
      });
      saveRules(rules);
      return { added, errors: [], total: rules.length };
    }

    // ---- Remedial ("Pre-Course") required-list — one-time import ----
    const REMEDIAL_KEY = 'gums_remedial_list';

    function loadRemedialList() {
      try {
        const raw = localStorage.getItem(REMEDIAL_KEY);
        return raw ? JSON.parse(raw) : [];
      } catch (e) {
        console.error('[GUMS] Failed to load remedial list, resetting.', e);
        return [];
      }
    }
    function saveRemedialList(list) {
      try {
        localStorage.setItem(REMEDIAL_KEY, JSON.stringify(list));
      } catch (e) {
        console.error('[GUMS] Failed to save remedial list.', e);
        alert('Could not save the remedial list — your browser blocked local storage on this page (' + e.message + ').');
        throw e;
      }
    }
    function clearRemedialList() { saveRemedialList([]); }

    function truthy(val) {
      if (!val) return false;
      const v = String(val).trim().toLowerCase();
      return v === 'yes' || v === 'y' || v === '1' || v === 'true';
    }

    // Accepts either:
    //   student_id,name,pre_english,pre_math      (YES/NO columns)
    //   student_id,name,pre_courses                (free text, e.g. "Pre-Math, Pre-English")
    function importRemedialCSV(csvText, mode) {
      const lines = csvText.split(/\r?\n/).filter(l => l.trim().length > 0);
      if (lines.length < 2) return { added: 0, errors: ['CSV appears empty or header-only.'], total: loadRemedialList().length };
      const header = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase());
      const idx = {
        id: header.indexOf('student_id'),
        name: header.indexOf('name'),
        eng: header.indexOf('pre_english'),
        math: header.indexOf('pre_math'),
        combined: header.indexOf('pre_courses')
      };
      if (idx.id === -1) return { added: 0, errors: ['CSV must include a student_id column.'], total: loadRemedialList().length };
      const errors = [];
      const parsed = [];
      for (let i = 1; i < lines.length; i++) {
        const cols = parseCSVLine(lines[i]);
        const studentId = cols[idx.id];
        if (!studentId) { errors.push(`Row ${i + 1}: missing student_id, skipped.`); continue; }
        const name = idx.name !== -1 ? (cols[idx.name] || '') : '';
        const courses = [];
        if (idx.eng !== -1 && truthy(cols[idx.eng])) courses.push('preEnglish');
        if (idx.math !== -1 && truthy(cols[idx.math])) courses.push('preMath');
        if (idx.combined !== -1 && cols[idx.combined]) {
          const combinedText = (cols[idx.combined] || '').toLowerCase(); // only this column, not the whole row
          if (combinedText.includes('pre-english') || combinedText.includes('pre english')) courses.push('preEnglish');
          if (combinedText.includes('pre-math') || combinedText.includes('pre math')) courses.push('preMath');
        }
        parsed.push({ studentId, name, courses: [...new Set(courses)] });
      }
      // mode 'replace' (default, since this is meant to be a one-time authoritative list) or 'merge'
      let list = mode === 'merge' ? loadRemedialList() : [];
      let added = 0;
      parsed.forEach(p => {
        const existingIdx = list.findIndex(r => r.studentId === p.studentId);
        if (existingIdx === -1) { list.push(p); added++; }
        else { list[existingIdx] = p; }
      });
      saveRemedialList(list);
      return { added, errors, total: list.length };
    }

    function getRemedialForStudent(studentId) {
      if (!studentId) return null;
      const list = loadRemedialList();
      const norm = String(studentId).trim();
      return list.find(r => String(r.studentId).trim() === norm) || null;
    }

    // per-student completed-course cache
    function getCachedCompleted(roll) {
      try {
        const raw = localStorage.getItem(HISTORY_CACHE_PREFIX + roll);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (Date.now() - parsed.timestamp > HISTORY_CACHE_MAX_AGE_MS) return null; // stale
        return parsed.courses;
      } catch { return null; }
    }
    function setCachedCompleted(roll, courses) {
      localStorage.setItem(HISTORY_CACHE_PREFIX + roll, JSON.stringify({ timestamp: Date.now(), courses }));
    }

    return {
      loadRules, saveRules, addRule, deleteRule, normalize, loadPrefs, savePrefs,
      importCSV, exportCSV, exportJSON, importJSON,
      getCachedCompleted, setCachedCompleted,
      loadRemedialList, saveRemedialList, clearRemedialList, importRemedialCSV, getRemedialForStudent
    };
  })();

  // ============================================================
  // PREREQUISITE ENGINE (with special rule handling)
  // ============================================================
  const PrerequisiteEngine = (() => {
    function getPrereqsForCourse(courseCode, rules) {
      const norm = StorageManager.normalize(courseCode);
      return rules.filter(r => StorageManager.normalize(r.courseCode) === norm);
    }

    function isCompleted(courseCode, completedCourses) {
      const norm = StorageManager.normalize(courseCode);
      return completedCourses.some(c => StorageManager.normalize(c.courseCode) === norm && c.isPassing);
    }

    function isCompletedOrInProgress(courseCode, completedCourses) {
      const norm = StorageManager.normalize(courseCode);
      return completedCourses.some(c => StorageManager.normalize(c.courseCode) === norm && (c.isPassing || c.isRunning));
    }

    function calculateTotalCredits(completedCourses) {
      let total = 0;
      const counted = new Set();
      completedCourses.forEach(c => {
        const norm = StorageManager.normalize(c.courseCode);
        // Only count each course once (best attempt) and only passing grades
        if (!counted.has(norm) && c.isPassing) {
          const credits = parseFloat(c.credit) || 0;
          total += credits;
          counted.add(norm);
        }
      });
      return total;
    }

    function checkSpecialRules(courseCode, completedCourses) {
      const norm = StorageManager.normalize(courseCode);
      const specialRule = SPECIAL_RULES[norm];

      if (!specialRule) {
        return { hasSpecialRules: false, eligible: true, violations: [] };
      }

      const violations = [];

      // Check minimum credits requirement
      if (specialRule.minCredits) {
        const totalCredits = calculateTotalCredits(completedCourses);
        if (totalCredits < specialRule.minCredits) {
          violations.push({
            type: 'credits',
            description: specialRule.description,
            required: specialRule.minCredits,
            current: totalCredits
          });
        }
      }

      // Check required courses (allows in-progress)
      if (specialRule.requiredCourses) {
        specialRule.requiredCourses.forEach(reqCode => {
          if (!isCompletedOrInProgress(reqCode, completedCourses)) {
            violations.push({
              type: 'course',
              description: `Required: ${reqCode}`,
              courseCode: reqCode
            });
          }
        });
      }

      return {
        hasSpecialRules: true,
        eligible: violations.length === 0,
        violations,
        description: specialRule.description
      };
    }

    function checkPrerequisites(courseCode, rules, completedCourses) {
      // Check standard prerequisite rules
      const prereqs = getPrereqsForCourse(courseCode, rules);
      const satisfied = [], missing = [];
      prereqs.forEach(p => (isCompleted(p.prereqCode, completedCourses) ? satisfied : missing).push(p));

      // Check special rules
      const specialCheck = checkSpecialRules(courseCode, completedCourses);

      // Combine results
      const standardEligible = missing.length === 0;
      const overallEligible = standardEligible && specialCheck.eligible;

      return {
        eligible: overallEligible,
        satisfied,
        missing,
        hasPrereqs: prereqs.length > 0,
        specialRules: specialCheck.hasSpecialRules ? specialCheck : null
      };
    }

    function getAllCourseCodesWithRules(rules) {
      const codesFromRules = new Set(rules.map(r => r.courseCode));
      // Also include courses with special rules
      Object.keys(SPECIAL_RULES).forEach(code => codesFromRules.add(code));
      return [...codesFromRules];
    }

    return { getPrereqsForCourse, isCompleted, checkPrerequisites, getAllCourseCodesWithRules, calculateTotalCredits };
  })();

  // ============================================================
  // REMEDIAL ENGINE (EAP009 / MAT009 pre-course status)
  // ============================================================
  const RemedialEngine = (() => {
    // Returns null if the student isn't on the imported remedial list at all.
    // Otherwise returns { studentId, name, courses: [ { key, code, label, required, record, status } ] }
    // status is one of: 'passed', 'not-passed' (attempted, F/I/W/AB), 'not-taken'
    function getStatus(studentId, completedCourses) {
      const entry = StorageManager.getRemedialForStudent(studentId);
      if (!entry) return null;
      const courses = REMEDIAL_COURSES
        .filter(rc => entry.courses.includes(rc.key))
        .map(rc => {
          const norm = StorageManager.normalize(rc.code);
          const record = (completedCourses || []).find(c => StorageManager.normalize(c.courseCode) === norm);
          let status = 'not-taken';
          if (record) status = record.isPassing ? 'passed' : 'not-passed';
          return { ...rc, record, status };
        });
      return { studentId: entry.studentId, name: entry.name, courses };
    }
    return { getStatus };
  })();

  // ============================================================
  // EXTRACTION LAYER (validated against real DOM dumps)
  // ============================================================
  function extractBaseCourseCode(rawCode) {
    if (!rawCode) return '';
    const match = rawCode.match(/^[A-Za-z]+[\s-]*\d+/);
    const base = match ? match[0] : rawCode;
    return base.toUpperCase().replace(/[\s-]+/g, '');
  }

  function extractStudentCourseHistory(doc) {
    doc = doc || document;
    const table = doc.getElementById('ctl00_MainContainer_gvRegisteredCourse');
    if (!table) return null;
    const results = [];
    table.querySelectorAll('[id$="_lblCourseCode"]').forEach((codeSpan) => {
      const row = codeSpan.closest('tr');
      if (!row) return;
      const prefix = codeSpan.id.replace('_lblCourseCode', '');
      const get = (suffix) => { const el = doc.getElementById(prefix + suffix); return el ? el.innerText.trim() : ''; };
      const cells = row.querySelectorAll('td');
      const rawCode = get('_lblCourseCode');
      if (!rawCode) return;
      const grade = (cells[6] ? cells[6].innerText : '').trim();
      const point = (cells[7] ? cells[7].innerText : '').trim();
      const status = (cells[8] ? cells[8].innerText : '').trim();
      results.push({
        courseCode: extractBaseCourseCode(rawCode),
        rawCode,
        courseTitle: get('_lblCourseName'),
        trimester: get('_lblSemester'),
        credit: get('_lblCourseCredit'),
        grade, point, status,
        // "Running Course" = currently in progress, not yet graded. It must NOT count
        // as satisfying a prerequisite (hence isPassing stays false via NON_PASSING_GRADES
        // including ''), but it's also not a failure — so it needs to be excluded from the
        // F/I/AB tab separately, or in-progress courses would wrongly show up as failed.
        isRunning: /running/i.test(status),
        isPassing: !NON_PASSING_GRADES.has(grade.toUpperCase())
      });
    });
    return results;
  }

  function getCompletedCoursesSummary(history) {
    const byCode = new Map();
    (history || []).forEach((h) => {
      const existing = byCode.get(h.courseCode);
      if (!existing || (h.isPassing && !existing.isPassing)) byCode.set(h.courseCode, { ...h });
    });
    return Array.from(byCode.values());
  }

  function extractSelectedCourses(doc) {
    doc = doc || document;
    const table = doc.getElementById('ctl00_MainContainer_gvCourseRegistration');
    if (!table) return null;
    const results = [];
    table.querySelectorAll('[id$="_lblFormalCode"]').forEach((codeSpan) => {
      const prefix = codeSpan.id.replace('_lblFormalCode', '');
      const get = (suffix) => { const el = doc.getElementById(prefix + suffix); return el ? el.innerText.trim() : ''; };
      const rawCode = get('_lblFormalCode');
      results.push({
        courseCode: extractBaseCourseCode(rawCode), rawCode,
        courseTitle: get('_lblCourseTitle'), credit: get('_lblCredits'), section: get('_lblSection')
      });
    });
    return results;
  }

  function extractCurriculumCourseList(doc) {
    doc = doc || document;
    const select = doc.getElementById('ctl00_MainContainer_ddlCourse');
    if (!select) return null;
    const results = [];
    Array.from(select.options).forEach((opt) => {
      if (opt.value === '0') return;
      const parts = opt.textContent.split('→').map(p => p.trim());
      if (parts.length < 4) return;
      const [rawCode, , title, credit] = parts;
      results.push({ courseCode: extractBaseCourseCode(rawCode), rawCode, courseTitle: title, credit, optionValue: opt.value });
    });
    return results;
  }

  function extractStudentRoll(doc) {
    doc = doc || document;
    const el = doc.getElementById('ctl00_MainContainer_lblRoll');
    return el ? el.innerText.trim() : null;
  }

  // ============================================================
  // HISTORY ACCESS (cache-only — no background fetch/iframe tricks)
  // ============================================================
  // Two full attempts (fetch, then a hidden iframe) at loading the history
  // page in the background both failed against this specific ASP.NET app —
  // the iframe attempt in particular triggered "__doPostBack is not defined"
  // errors and timeouts, suggesting the page actively resists being loaded
  // this way (frame-busting script or similar). Rather than keep fighting
  // that, we rely on the one thing that's been 100% reliable in testing:
  // a real page visit. The entry point at the bottom of this file already
  // caches completed courses whenever StudentCourseHistory.aspx loads for
  // real. Here we just read that cache — instantly, no network wait — and
  // if it's missing, point the advisor at a one-click real visit instead.
  const HistoryAccess = (() => {
    function getCompletedCourses(roll) {
      return StorageManager.getCachedCompleted(roll); // null if not cached / stale
    }
    return { getCompletedCourses };
  })();

  // ============================================================
  // UI MANAGER
  // ============================================================
  const UI = (() => {
    let panelEl = null;

    // ASP.NET partial postbacks (UpdatePanel refreshes) can wipe out and
    // replace chunks of the DOM, detaching panelEl without ever calling the
    // close handlers that null it out. A raw `if (panelEl)` check would then
    // stay falsely "open forever" — openDashboard() refuses to reopen, and
    // the table watcher / storage listener keep trying to update a dead
    // element. This checks liveness and self-heals the stale reference.
    function isPanelOpen() {
      if (panelEl && !document.body.contains(panelEl)) panelEl = null;
      return !!panelEl;
    }
    let state = { completedCourses: [], selectedCourses: [], rules: [], debug: false, historyError: false, needsHistoryVisit: false };

    function injectStyles() {
      const style = document.createElement('style');
      style.textContent = `
        .gums-fab { position: fixed; bottom: 24px; right: 24px; z-index: 999997; background: linear-gradient(90deg,#2f9020,#7dd061);
          color: #fff; border: none; border-radius: 999px; padding: 12px 18px; font-family: Arial, 'Segoe UI', sans-serif;
          font-size: 14px; font-weight: bold; cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,0.25); }
        .gums-fab:hover { background: linear-gradient(90deg,#256e18,#63b247); }
        .gums-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.45); z-index: 999998; display: flex;
          align-items: center; justify-content: center; font-family: Arial, 'Segoe UI', sans-serif; }
        .gums-panel { background: #fff; width: 92%; max-width: 1000px; height: 85%; border-radius: 6px; display: flex;
          flex-direction: column; overflow: hidden; box-shadow: 0 10px 40px rgba(0,0,0,0.3); border: 1px solid #ddd; }
        .gums-header { background: #fff; color: #0c7c3e; padding: 14px 20px; display: flex; justify-content: space-between;
          align-items: center; border-bottom: 3px solid #0c7c3e; }
        .gums-header h2 { margin: 0; font-size: 19px; font-weight: bold; color: #0c7c3e; }
        .gums-close { background: transparent; border: none; color: #555; font-size: 20px; cursor: pointer; }
        .gums-close:hover { color: #ff0000; }
        .gums-tabs { display: flex; flex-wrap: wrap; border-bottom: 1px solid #ddd; background: #f2f2f2; }
        .gums-tab { padding: 10px 16px; cursor: pointer; font-size: 13px; color: #2e2967; border-bottom: 3px solid transparent; }
        .gums-tab:hover { background: #e8e8e8; }
        .gums-tab.active { color: #0c7c3e; border-bottom-color: #0c7c3e; font-weight: bold; background: #fff; }
        .gums-body { flex: 1; overflow-y: auto; padding: 20px; }
        .gums-disclaimer { flex-shrink: 0; padding: 8px 16px; font-size: 11px; line-height: 1.4; color: #8a6d00;
          background: #fff8e1; border-top: 1px solid #f0e0a0; }
        .gums-disclaimer b { color: #6b5400; }
        .gums-disclaimer-inline { font-size: 11px; line-height: 1.4; color: #8a6d00; background: #fff8e1;
          border: 1px solid #f0e0a0; border-radius: 4px; padding: 8px 10px; margin-top: 10px; }
        .gums-stats { display: flex; gap: 12px; flex-wrap: wrap; margin-bottom: 16px; }
        .gums-stat-card { background: #daf8fb; border: 1px solid #b9e8ee; border-radius: 6px; padding: 14px 18px; min-width: 120px; }
        .gums-stat-card:nth-child(even) { background: #e6f3d9; border-color: #cbe4b3; }
        .gums-stat-card .n { font-size: 24px; font-weight: 700; color: #0c7c3e; }
        .gums-stat-card .l { font-size: 12px; color: #555; margin-top: 2px; }
        .gums-course-card { border: 1px solid #d8d8d8; border-radius: 4px; padding: 12px 14px; margin-bottom: 8px; cursor: pointer;
          background: #daf8fb; }
        .gums-course-card:nth-child(even) { background: #e6f3d9; }
        .gums-course-card:hover { filter: brightness(0.97); }
        .gums-course-card .title { font-weight: bold; font-size: 14px; color: #222; }
        .gums-course-card .code { font-size: 12px; color: #555; }
        .gums-badge { display: inline-block; padding: 2px 8px; border-radius: 3px; font-size: 11px; font-weight: bold; margin-left: 8px; }
        .gums-badge.eligible { background: #dff0d8; color: #0c7c3e; }
        .gums-badge.ineligible { background: #fde2e2; color: #ff0000; }
        .gums-badge.warn { background: #fdf3e3; color: #a8710a; }
        .gums-prereq-line { font-size: 13px; margin: 3px 0; }
        .gums-prereq-line.ok { color: #0c7c3e; }
        .gums-prereq-line.missing { color: #ff0000; }
        .gums-special-rule { font-size: 13px; margin: 8px 0; padding: 8px; background: #fff8e1; border-left: 3px solid #a8710a; }
        .gums-special-rule.ok { background: #dff0d8; border-left-color: #0c7c3e; }
        .gums-form-row { margin-bottom: 10px; }
        .gums-form-row input, .gums-form-row textarea { width: 100%; padding: 7px; border: 1px solid #b7c6d1; border-radius: 4px;
          box-sizing: border-box; font-size: 13px; font-family: Arial, 'Segoe UI', sans-serif; }
        .gums-form-row input:focus, .gums-form-row textarea:focus { outline: none; border-color: #337ab7; }
        .gums-btn { background: linear-gradient(90deg,#2f9020,#7dd061); color: #fff; border: none; border-radius: 4px;
          padding: 8px 14px; cursor: pointer; font-size: 13px; font-weight: bold; }
        .gums-btn:hover { background: linear-gradient(90deg,#256e18,#63b247); }
        .gums-btn.secondary { background: #337ab7; color: #fff; }
        .gums-btn.secondary:hover { background: #285f8f; }
        .gums-btn.danger { background: #ff0000; }
        .gums-btn.danger:hover { background: #c00; }
        .gums-empty { color: #666; font-size: 13px; padding: 20px; text-align: center; }
        .gums-warning-banner { position: fixed; top: 20px; right: 24px; z-index: 999999; background: #fde2e2; border: 1px solid #ff0000;
          border-radius: 6px; padding: 14px 18px; max-width: 340px; box-shadow: 0 4px 14px rgba(0,0,0,0.2);
          font-family: Arial, 'Segoe UI', sans-serif; color: #333; }
        .gums-warning-banner.ok { background: #dff0d8; border-color: #0c7c3e; }
        .gums-warning-banner .gums-verify-note { display: block; margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(0,0,0,0.12);
          font-size: 11px; font-weight: normal; font-style: italic; color: #555; }
        .gums-rule-row { display: flex; gap: 8px; align-items: center; padding: 6px 4px; border-bottom: 1px solid #eee; font-size: 13px; }
        .gums-rule-row:nth-child(odd) { background: #f7fcfd; }
        .gums-rule-row span { flex: 1; }
      `;
      document.head.appendChild(style);
    }

    function createFAB() {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'gums-fab';
      btn.textContent = '📋 Prerequisite Checker';
      btn.onclick = openDashboard;
      document.body.appendChild(btn);
    }

    function showWarningBanner(message, ok) {
      const existing = document.querySelector('.gums-warning-banner');
      if (existing) existing.remove();
      const banner = document.createElement('div');
      banner.className = 'gums-warning-banner' + (ok ? ' ok' : '');
      banner.innerHTML = message + '<span class="gums-verify-note">⚠ Advisory hint only — please verify against the official result history.</span>';
      document.body.appendChild(banner);
      setTimeout(() => banner.remove(), 9000);
    }

    function refreshData() {
      state.rules = StorageManager.loadRules();
      state.selectedCourses = extractSelectedCourses() || [];
      state.historyError = false;
      state.needsHistoryVisit = false;
      const roll = extractStudentRoll();
      if (!roll) {
        state.completedCourses = [];
        state.historyError = true; // couldn't even find the student's roll on the page
        return;
      }
      const completed = HistoryAccess.getCompletedCourses(roll);
      if (completed === null) {
        state.completedCourses = [];
        state.needsHistoryVisit = true; // just not cached yet — not an error, just needs one visit
      } else {
        state.completedCourses = completed;
      }
    }

    function computeStats() {
      const completed = state.completedCourses.filter(c => c.isPassing).length;
      const incomplete = state.completedCourses.filter(c => !c.isPassing).length;
      const selected = state.selectedCourses.length;
      let violations = 0;
      state.selectedCourses.forEach(sc => {
        const result = PrerequisiteEngine.checkPrerequisites(sc.courseCode, state.rules, state.completedCourses);
        if (!result.eligible) violations++;
      });
      return { completed, incomplete, selected, violations };
    }

    function renderSummaryTab() {
      const stats = computeStats();
      const totalCredits = PrerequisiteEngine.calculateTotalCredits(state.completedCourses);
      const el = document.createElement('div');
      el.innerHTML = `
        <div class="gums-stats">
          <div class="gums-stat-card"><div class="n">${stats.completed}</div><div class="l">Completed</div></div>
          <div class="gums-stat-card"><div class="n">${stats.incomplete}</div><div class="l">Incomplete/In Progress</div></div>
          <div class="gums-stat-card"><div class="n">${totalCredits.toFixed(1)}</div><div class="l">Total Credits</div></div>
          <div class="gums-stat-card"><div class="n">${stats.selected}</div><div class="l">Selected This Term</div></div>
          <div class="gums-stat-card"><div class="n">${stats.violations}</div><div class="l">Prerequisite Violations</div></div>
        </div>
        <h4>This Term's Selections</h4>
        <div id="gums-selected-list"></div>
      `;
      const list = el.querySelector('#gums-selected-list');
      if (state.selectedCourses.length === 0) {
        list.innerHTML = '<div class="gums-empty">No courses currently selected.</div>';
      } else {
        state.selectedCourses.forEach(sc => {
          const result = PrerequisiteEngine.checkPrerequisites(sc.courseCode, state.rules, state.completedCourses);
          const card = document.createElement('div');
          card.className = 'gums-course-card';
          const badgeClass = result.eligible ? 'eligible' : 'ineligible';
          const badgeText = result.hasPrereqs || (result.specialRules && result.specialRules.hasSpecialRules)
            ? (result.eligible ? 'ELIGIBLE' : 'NOT ELIGIBLE')
            : 'NO PREREQS';
          card.innerHTML = `<div class="title">${sc.courseTitle} <span class="gums-badge ${badgeClass}">${badgeText}</span></div><div class="code">${sc.rawCode}</div>`;
          card.onclick = () => openCourseModal(sc.courseCode, sc.courseTitle);
          list.appendChild(card);
        });
      }
      return el;
    }

    function renderAnalysisTab() {
      const el = document.createElement('div');
      const courseCodes = PrerequisiteEngine.getAllCourseCodesWithRules(state.rules);
      if (courseCodes.length === 0) {
        el.innerHTML = `<div class="gums-empty">No prerequisite rules found.<br>Please import or add prerequisite data from the Rules tab.</div>`;
        return el;
      }
      courseCodes.forEach(code => {
        const rule = state.rules.find(r => StorageManager.normalize(r.courseCode) === StorageManager.normalize(code));
        const result = PrerequisiteEngine.checkPrerequisites(code, state.rules, state.completedCourses);
        const card = document.createElement('div');
        card.className = 'gums-course-card';
        let lines = '';
        result.satisfied.forEach(p => lines += `<div class="gums-prereq-line ok">✓ ${p.prereqCode} - ${p.prereqTitle}</div>`);
        result.missing.forEach(p => lines += `<div class="gums-prereq-line missing">✗ ${p.prereqCode} - ${p.prereqTitle}</div>`);

        // Add special rules display
        if (result.specialRules && result.specialRules.hasSpecialRules) {
          result.specialRules.violations.forEach(v => {
            if (v.type === 'credits') {
              lines += `<div class="gums-prereq-line missing">✗ Minimum ${v.required} credits required (current: ${v.current})</div>`;
            } else if (v.type === 'course') {
              lines += `<div class="gums-prereq-line missing">✗ ${v.description}</div>`;
            }
          });
          if (result.specialRules.eligible) {
            lines += `<div class="gums-prereq-line ok">✓ Special requirements satisfied</div>`;
          }
        }

        card.innerHTML = `<div class="title">${rule ? rule.courseTitle || '' : code} <span class="gums-badge ${result.eligible ? 'eligible' : 'ineligible'}">${result.eligible ? 'ELIGIBLE' : 'NOT ELIGIBLE'}</span></div><div class="code">${code}</div>${lines}`;
        card.onclick = () => openCourseModal(code, rule ? rule.courseTitle : '');
        el.appendChild(card);
      });
      return el;
    }

    function renderIneligibleTab() {
      const el = document.createElement('div');
      const codes = PrerequisiteEngine.getAllCourseCodesWithRules(state.rules);
      const ineligible = codes.filter(c => !PrerequisiteEngine.checkPrerequisites(c, state.rules, state.completedCourses).eligible);
      if (ineligible.length === 0) { el.innerHTML = '<div class="gums-empty">No ineligible courses — nice.</div>'; return el; }
      ineligible.forEach(code => {
        const rule = state.rules.find(r => StorageManager.normalize(r.courseCode) === StorageManager.normalize(code));
        const result = PrerequisiteEngine.checkPrerequisites(code, state.rules, state.completedCourses);
        const card = document.createElement('div');
        card.className = 'gums-course-card';
        let lines = `<div class="title">✗ ${code} - ${rule ? rule.courseTitle || '' : ''}</div><div style="margin-top:4px;">Missing:</div>`;
        result.missing.forEach(p => lines += `<div class="gums-prereq-line missing">${p.prereqCode} - ${p.prereqTitle}</div>`);

        if (result.specialRules && result.specialRules.violations.length > 0) {
          result.specialRules.violations.forEach(v => {
            if (v.type === 'credits') {
              lines += `<div class="gums-prereq-line missing">Minimum ${v.required} credits required (current: ${v.current})</div>`;
            } else if (v.type === 'course') {
              lines += `<div class="gums-prereq-line missing">${v.description}</div>`;
            }
          });
        }

        card.innerHTML = lines;
        el.appendChild(card);
      });
      return el;
    }

    function renderNonPassingTab() {
      const el = document.createElement('div');
      const nonPassing = state.completedCourses.filter(c => !c.isPassing && !c.isRunning);
      if (nonPassing.length === 0) {
        el.innerHTML = '<div class="gums-empty">No F / I / AB courses on record.</div>';
        return el;
      }
      nonPassing.forEach(c => {
        const card = document.createElement('div');
        card.className = 'gums-course-card';
        const gradeLabel = c.grade ? c.grade.toUpperCase() : '—';
        card.innerHTML = `<div class="title">${c.courseTitle || ''} <span class="gums-badge ineligible">${gradeLabel}</span></div><div class="code">${c.courseCode}${c.trimester ? ' · ' + c.trimester : ''}</div>`;
        el.appendChild(card);
      });
      return el;
    }

    function renderRulesTab() {
      const el = document.createElement('div');
      el.innerHTML = `
        <h4>Special Rules (Built-in)</h4>
        <div style="font-size:12px;color:#555;margin-bottom:14px;">
          <div class="gums-special-rule ok">✓ CSE 400a: Requires at least 100 completed credits</div>
          <div class="gums-special-rule ok">✓ CSE 300b: Requires CSE 400a (completed or in progress)</div>
          <div class="gums-special-rule ok">✓ CSE 400c: Requires both CSE 400a and CSE 400b (completed or in progress)</div>
        </div>
        <hr style="margin:18px 0;">
        <h4>Add a rule</h4>
        <div class="gums-form-row"><input id="gums-r-code" placeholder="Course code (e.g. CSE401)"></div>
        <div class="gums-form-row"><input id="gums-r-title" placeholder="Course title (optional)"></div>
        <div class="gums-form-row"><input id="gums-r-pcode" placeholder="Prerequisite code (e.g. CSE303)"></div>
        <div class="gums-form-row"><input id="gums-r-ptitle" placeholder="Prerequisite title (optional)"></div>
        <button type="button" class="gums-btn" id="gums-add-rule">Add Rule</button>
        <hr style="margin:18px 0;">
        <h4>Bulk import (CSV)</h4>
        <p style="font-size:12px;color:#777;">Header: course_code,course_title,prerequisite_code,prerequisite_title</p>
        <div class="gums-form-row"><textarea id="gums-csv-input" rows="4" placeholder="Paste CSV here"></textarea></div>
        <button type="button" class="gums-btn secondary" id="gums-import-csv">Import CSV</button>
        <button type="button" class="gums-btn secondary" id="gums-export-csv">Export CSV</button>
        <button type="button" class="gums-btn secondary" id="gums-export-json">Export JSON</button>
        <div id="gums-import-msg" style="font-size:12px;margin-top:8px;"></div>
        <hr style="margin:18px 0;">
        <h4>Current rules (${state.rules.length})</h4>
        <div id="gums-rules-list"></div>
      `;
      const list = el.querySelector('#gums-rules-list');
      state.rules.forEach(r => {
        const row = document.createElement('div');
        row.className = 'gums-rule-row';
        row.innerHTML = `<span>${r.courseCode} (${r.courseTitle || '—'})</span><span>requires</span><span>${r.prereqCode} (${r.prereqTitle || '—'})</span>`;
        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'gums-btn danger'; del.textContent = 'Delete'; del.style.fontSize = '11px'; del.style.padding = '4px 8px';
        del.onclick = () => { StorageManager.deleteRule(r.courseCode, r.prereqCode); renderBody(); };
        row.appendChild(del);
        list.appendChild(row);
      });

      el.querySelector('#gums-add-rule').onclick = () => {
        try {
          const code = el.querySelector('#gums-r-code').value.trim();
          const title = el.querySelector('#gums-r-title').value.trim();
          const pcode = el.querySelector('#gums-r-pcode').value.trim();
          const ptitle = el.querySelector('#gums-r-ptitle').value.trim();
          if (!code || !pcode) { alert('Course code and prerequisite code are required.'); return; }
          StorageManager.addRule(code, title, pcode, ptitle);
          renderBody();
        } catch (e) {
          console.error('[GUMS] Add Rule failed.', e);
        }
      };
      el.querySelector('#gums-import-csv').onclick = () => {
        const csv = el.querySelector('#gums-csv-input').value;
        const result = StorageManager.importCSV(csv);
        el.querySelector('#gums-import-msg').textContent = `Added ${result.added} rule(s). ${result.errors.join(' ')}`;
        renderBody();
      };
      el.querySelector('#gums-export-csv').onclick = () => downloadText(StorageManager.exportCSV(), 'gums-prerequisites.csv');
      el.querySelector('#gums-export-json').onclick = () => downloadText(StorageManager.exportJSON(), 'gums-prerequisites.json');
      return el;
    }

    function renderRemedialTab() {
      const el = document.createElement('div');
      const list = StorageManager.loadRemedialList();

      const driveLinkHtml = `
        <div class="gums-course-card" style="margin-bottom:14px;">
          <div class="title">📄 Batch-wise Eligible Students List (PDF)</div>
          <div class="code">
            <a href="https://drive.google.com/drive/folders/1vMPnbiReY5nYxPHY0WSHHrHvkatDSQrH" target="_blank" rel="noopener noreferrer" style="color:#0c7c3e;text-decoration:underline;">
              Open Google Drive folder ↗
            </a>
          </div>
        </div>
      `;

      const importSectionHtml = `
        <h4>${list.length === 0 ? 'Import remedial list (one-time)' : 'Replace remedial list'}</h4>
        <p style="font-size:12px;color:#777;line-height:1.5;">
          Paste the pre-course CSV — header: <code>student_id,name,pre_english,pre_math</code> (values <code>YES</code>/<code>NO</code>),
          or <code>student_id,name,pre_courses</code> with free text like "Pre-Math, Pre-English".
          This is a one-time import for the whole batch — importing again <b>replaces</b> the saved list.
        </p>
        <div class="gums-form-row"><textarea id="gums-remedial-csv" rows="5" placeholder="student_id,name,pre_english,pre_math&#10;241002018,Pranto Biswas,YES,NO"></textarea></div>
        <button type="button" class="gums-btn" id="gums-remedial-import">${list.length === 0 ? 'Import List' : 'Replace List'}</button>
        <div id="gums-remedial-import-msg" style="font-size:12px;margin-top:8px;"></div>
      `;

      if (list.length === 0) {
        el.innerHTML = `${driveLinkHtml}<div class="gums-empty" style="margin-bottom:14px;">No remedial list imported yet.</div>${importSectionHtml}`;
        el.querySelector('#gums-remedial-import').onclick = () => {
          const csv = el.querySelector('#gums-remedial-csv').value;
          const result = StorageManager.importRemedialCSV(csv, 'replace');
          el.querySelector('#gums-remedial-import-msg').textContent = `Imported ${result.added} student(s) into the remedial list. ${result.errors.join(' ')}`;
          renderBody();
        };
        return el;
      }

      const roll = extractStudentRoll();
      const status = roll ? RemedialEngine.getStatus(roll, state.completedCourses) : null;

      let studentHtml;
      if (!roll) {
        studentHtml = `<div class="gums-empty">Unable to detect the student ID on this page.</div>`;
      } else if (!status) {
        studentHtml = `<div class="gums-course-card"><div class="title">✓ No remedial course required <span class="gums-badge eligible">NOT LISTED</span></div><div class="code">Roll ${roll} is not on the imported remedial list.</div></div>`;
      } else {
        const allPassed = status.courses.length > 0 && status.courses.every(c => c.status === 'passed');
        let lines = '';
        status.courses.forEach(c => {
          let badgeClass = 'ineligible', badgeText = 'NOT TAKEN', detail = 'No record of this course found in the result history.';
          if (c.status === 'passed') {
            badgeClass = 'eligible'; badgeText = 'COMPLETED';
            detail = `Result: Grade ${c.record.grade || '—'}${c.record.point ? ' (' + c.record.point + ')' : ''}${c.record.trimester ? ' · ' + c.record.trimester : ''}`;
          } else if (c.status === 'not-passed') {
            badgeClass = 'warn'; badgeText = 'NOT PASSED — RETAKE';
            detail = `Attempted, grade ${c.record.grade || '—'}${c.record.trimester ? ' · ' + c.record.trimester : ''} — needs to be retaken.`;
          }
          lines += `<div class="gums-course-card"><div class="title">${c.label} <span class="gums-badge ${badgeClass}">${badgeText}</span></div><div class="code">${detail}</div></div>`;
        });
        studentHtml = `
          <div style="margin-bottom:10px;">Roll <b>${status.studentId}</b>${status.name ? ' — ' + status.name : ''} is <b>required</b> to complete: ${status.courses.map(c => c.label).join(', ')}
            <span class="gums-badge ${allPassed ? 'eligible' : 'ineligible'}">${allPassed ? 'ALL COMPLETED' : 'PENDING'}</span>
          </div>
          ${lines}`;
      }

      el.innerHTML = `
        ${driveLinkHtml}
        <h4>This student's remedial status</h4>
        ${studentHtml}
        <hr style="margin:18px 0;">
        <div style="font-size:12px;color:#777;margin-bottom:10px;">Remedial list currently has ${list.length} student(s) imported.</div>
        <details><summary style="cursor:pointer;font-size:13px;color:#0c7c3e;">Replace the imported list</summary><div style="margin-top:10px;">${importSectionHtml}</div></details>
      `;
      el.querySelector('#gums-remedial-import').onclick = () => {
        const csv = el.querySelector('#gums-remedial-csv').value;
        const result = StorageManager.importRemedialCSV(csv, 'replace');
        el.querySelector('#gums-remedial-import-msg').textContent = `Imported ${result.added} student(s) into the remedial list. ${result.errors.join(' ')}`;
        renderBody();
      };
      return el;
    }

    function downloadText(text, filename) {
      const blob = new Blob([text], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
    }

    const TABS = [
      { id: 'summary', label: 'Summary', render: renderSummaryTab },
      { id: 'analysis', label: 'Prerequisite Analysis', render: renderAnalysisTab },
      { id: 'ineligible', label: 'Missing Prerequisites', render: renderIneligibleTab },
      { id: 'nonpassing', label: 'F / I / AB', render: renderNonPassingTab },
      { id: 'remedial', label: 'Remedial (EAP/MAT)', render: renderRemedialTab },
      { id: 'rules', label: 'Rules', render: renderRulesTab },
    ];
    let activeTab = 'summary';

    function renderBody() {
      if (!isPanelOpen()) return;
      state.rules = StorageManager.loadRules(); // always reflect latest saved rules (add/delete/import can happen between renders)
      const body = panelEl.querySelector('.gums-body');
      body.innerHTML = '';
      if (state.historyError) {
        const warn = document.createElement('div');
        warn.style.cssText = 'background:#fde2e2;border:1px solid #ff0000;border-radius:6px;padding:12px 16px;margin-bottom:16px;font-size:13px;color:#8a2c2c;';
        warn.innerHTML = '⚠ Unable to detect student information on this page.<br>The website structure may have changed. Try reloading the page.';
        body.appendChild(warn);
      } else if (state.needsHistoryVisit) {
        const notice = document.createElement('div');
        notice.style.cssText = 'background:#daf8fb;border:1px solid #337ab7;border-radius:6px;padding:12px 16px;margin-bottom:16px;font-size:13px;color:#204a6b;';
        notice.innerHTML = '📄 Completed-course data isn\'t cached for this student yet.<br>Click "Show Result History" on the page — it loads in a new tab, and this dashboard will pick up the data automatically when you switch back here.';
        body.appendChild(notice);
      }
      const tab = TABS.find(t => t.id === activeTab);
      body.appendChild(tab.render());
      panelEl.querySelectorAll('.gums-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === activeTab));
    }

    function openCourseModal(courseCode, courseTitle) {
      const result = PrerequisiteEngine.checkPrerequisites(courseCode, state.rules, state.completedCourses);
      const overlay = document.createElement('div');
      overlay.className = 'gums-overlay';
      overlay.style.zIndex = 1000000;
      const box = document.createElement('div');
      box.className = 'gums-panel';
      box.style.height = 'auto'; box.style.maxWidth = '480px';
      let lines = '';
      [...result.satisfied, ...result.missing].forEach(p => {
        const ok = result.satisfied.includes(p);
        lines += `<div class="gums-prereq-line ${ok ? 'ok' : 'missing'}">${ok ? '✓' : '✗'} ${p.prereqCode} - ${p.prereqTitle}</div>`;
      });

      // Add special rules to modal
      if (result.specialRules && result.specialRules.hasSpecialRules) {
        lines += '<h4 style="margin-top:16px;">Special Requirements</h4>';
        if (result.specialRules.violations.length > 0) {
          result.specialRules.violations.forEach(v => {
            if (v.type === 'credits') {
              lines += `<div class="gums-prereq-line missing">✗ Minimum ${v.required} credits required (current: ${v.current.toFixed(1)})</div>`;
            } else if (v.type === 'course') {
              lines += `<div class="gums-prereq-line missing">✗ ${v.description}</div>`;
            }
          });
        } else {
          lines += '<div class="gums-prereq-line ok">✓ All special requirements satisfied</div>';
        }
      }

      if (!result.hasPrereqs && (!result.specialRules || !result.specialRules.hasSpecialRules)) {
        lines = '<div class="gums-empty">No prerequisite rules configured for this course.</div>';
      }

      box.innerHTML = `
        <div class="gums-header"><h2>${courseTitle || courseCode}</h2><button type="button" class="gums-close">✕</button></div>
        <div class="gums-body">
          <div class="code" style="margin-bottom:10px;color:#777;">${courseCode}</div>
          <h4>Prerequisites</h4>${lines}
          <h4 style="margin-top:16px;">Final Status</h4>
          <div class="gums-badge ${result.eligible ? 'eligible' : 'ineligible'}" style="font-size:13px;">${(result.hasPrereqs || (result.specialRules && result.specialRules.hasSpecialRules)) ? (result.eligible ? 'ELIGIBLE' : 'NOT ELIGIBLE') : 'NO PREREQUISITES REQUIRED'}</div>
          <div class="gums-disclaimer-inline">⚠ <b>Advisory hint only —</b> please verify against the official result history before making a decision. &nbsp;·&nbsp; <a href="${SOURCE_URL}" target="_blank" rel="noopener noreferrer" style="color:#0c7c3e;">Source code ↗</a></div>
        </div>`;
      overlay.appendChild(box);
      overlay.querySelector('.gums-close').onclick = () => overlay.remove();
      overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
      document.body.appendChild(overlay);
    }

    function showHistoryRequiredPopup() {
      const existing = document.querySelector('.gums-history-required-overlay');
      if (existing) existing.remove();
      const overlay = document.createElement('div');
      overlay.className = 'gums-overlay gums-history-required-overlay';
      overlay.style.zIndex = 1000001;
      const box = document.createElement('div');
      box.className = 'gums-panel';
      box.style.height = 'auto';
      box.style.maxWidth = '420px';
      box.innerHTML = `
        <div class="gums-header"><h2>📄 Show Result History First</h2><button type="button" class="gums-close">✕</button></div>
        <div class="gums-body">
          <p style="font-size:14px;line-height:1.5;margin:0 0 16px;">
            This student's completed courses aren't loaded yet. Close this popup, then click <b>"Show Result History"</b> on the page itself. Once it loads, come back here and open the Prerequisite Checker again.
          </p>
          <button type="button" class="gums-btn" id="gums-history-required-ok">Got it</button>
          <div class="gums-disclaimer-inline">⚠ <b>Advisory hint only —</b> this tool is meant to give a quick hint, not a final answer. Always verify against the official result history. &nbsp;·&nbsp; <a href="${SOURCE_URL}" target="_blank" rel="noopener noreferrer" style="color:#0c7c3e;">Source code ↗</a></div>
        </div>`;
      overlay.appendChild(box);
      const close = () => overlay.remove();
      overlay.querySelector('.gums-close').onclick = close;
      overlay.onclick = (e) => { if (e.target === overlay) close(); };
      box.querySelector('#gums-history-required-ok').onclick = close;
      document.body.appendChild(overlay);
    }

    function openDashboard() {
      if (isPanelOpen()) return;
      refreshData(); // instant — cache read only, no network wait
      if (state.needsHistoryVisit) {
        showHistoryRequiredPopup();
        return;
      }
      const overlay = document.createElement('div');
      overlay.className = 'gums-overlay';
      const panel = document.createElement('div');
      panel.className = 'gums-panel';
      panel.innerHTML = `
        <div class="gums-header"><h2>📋 Prerequisite Checker</h2><button type="button" class="gums-close">✕</button></div>
        <div class="gums-tabs">${TABS.map(t => `<div class="gums-tab" data-tab="${t.id}">${t.label}</div>`).join('')}</div>
        <div class="gums-body"></div>
        <div class="gums-disclaimer">⚠ <b>Advisory tool only —</b> rules, remedial data, and result-history caching are entered/maintained manually and may be incomplete or outdated. Always verify against the official GUMS record and result history before approving or rejecting a course. &nbsp;·&nbsp; <a href="${SOURCE_URL}" target="_blank" rel="noopener noreferrer" style="color:#0c7c3e;">Source code ↗</a></div>
      `;
      overlay.appendChild(panel);
      document.body.appendChild(overlay);
      panelEl = panel;

      panel.querySelector('.gums-close').onclick = () => { overlay.remove(); panelEl = null; };
      overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); panelEl = null; } };
      panel.querySelectorAll('.gums-tab').forEach(t => t.onclick = () => { activeTab = t.dataset.tab; renderBody(); });

      renderBody();
    }

    // ---- Selection monitor: warn advisor when picking a course from the "Add New Course" dropdown ----
    function initSelectionMonitor() {
      const select = document.getElementById('ctl00_MainContainer_ddlCourse');
      if (!select) return;
      select.addEventListener('change', () => {
        const opt = select.options[select.selectedIndex];
        if (!opt || opt.value === '0') return;
        const parts = opt.textContent.split('→').map(p => p.trim());
        if (parts.length < 4) return;
        const rawCode = parts[0];
        const courseCode = extractBaseCourseCode(rawCode);
        const courseTitle = parts[2];

        refreshData();
        if (state.needsHistoryVisit) {
          showWarningBanner(`<b>📄 Completed-course data not cached yet</b><br>Open "Result History" once from the dashboard's Summary tab before selecting courses, so violations can be checked accurately.`, false);
          return;
        }
        const result = PrerequisiteEngine.checkPrerequisites(courseCode, state.rules, state.completedCourses);
        const hasAnyReqs = result.hasPrereqs || (result.specialRules && result.specialRules.hasSpecialRules);
        if (!hasAnyReqs) return; // nothing to warn about
        if (result.eligible) {
          showWarningBanner(`<b>✓ Prerequisites Satisfied</b><br>${courseTitle} (${courseCode})<br>All prerequisites have been completed.`, true);
        } else {
          let missingList = result.missing.map(m => `✗ ${m.prereqCode} - ${m.prereqTitle}`).join('<br>');
          if (result.specialRules && result.specialRules.violations.length > 0) {
            result.specialRules.violations.forEach(v => {
              if (v.type === 'credits') {
                missingList += `<br>✗ Minimum ${v.required} credits required (current: ${v.current.toFixed(1)})`;
              } else if (v.type === 'course') {
                missingList += `<br>✗ ${v.description}`;
              }
            });
          }
          showWarningBanner(`<b>⚠ PREREQUISITE VIOLATION</b><br>${courseTitle} (${courseCode})<br>Missing:<br>${missingList}<br><i>This course should not be selected.</i>`, false);
        }
      });
    }

    // Re-render open dashboard + re-check when the registration table changes (partial postback)
    function initTableWatcher() {
      const table = document.getElementById('ctl00_MainContainer_gvCourseRegistration');
      if (!table) return;
      let debounceTimer = null;
      const observer = new MutationObserver(() => {
        // ASP.NET partial postbacks can fire dozens of mutations in quick
        // succession (row-by-row DOM rebuilds); debounce so refreshData()+
        // renderBody() run once per burst instead of once per mutation.
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          if (isPanelOpen()) { refreshData(); renderBody(); }
        }, 300);
      });
      observer.observe(table, { childList: true, subtree: true });
    }

    // Auto-refresh the open dashboard when another tab (e.g. the Result History
    // tab the advisor just opened) writes newly-cached completed-course data.
    function initStorageListener() {
      window.addEventListener('storage', (e) => {
        if (e.key && e.key.indexOf(HISTORY_CACHE_PREFIX) === 0 && isPanelOpen()) {
          refreshData();
          renderBody();
        }
      });
    }

    function init() {
      injectStyles();
      createFAB();
      initStorageListener();
      if (document.getElementById('ctl00_MainContainer_ddlCourse')) initSelectionMonitor();
      if (document.getElementById('ctl00_MainContainer_gvCourseRegistration')) initTableWatcher();

      if (StorageManager.loadRules().length === 0) {
        console.info('[GUMS] No prerequisite rules configured yet. Open the dashboard → Rules tab to add or import some.');
      }
    }

    return { init };
  })();

  // ============================================================
  // ENTRY POINT
  // ============================================================
  if (location.pathname.includes('/Registration/Registration.aspx')) {
    UI.init();
  } else if (location.pathname.includes('/Student/StudentCourseHistory.aspx')) {
    // Silently cache this student's completed courses if we land here directly
    const roll = extractStudentRoll();
    const history = extractStudentCourseHistory();
    if (roll && history) {
      StorageManager.setCachedCompleted(roll, getCompletedCoursesSummary(history));
      console.info('[GUMS] Cached completed courses for roll', roll);
    }
  }
})();
