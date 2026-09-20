// ==UserScript==
// @name         GUMS Prerequisite Checker
// @namespace    https://green.edu.bd/
// @version      2.0.0
// @description  Advisor-side prerequisite validation dashboard for GUMS registration (curricula 2018 / 2020 / 2023 built-in, auto-selected from student ID)
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

  // ============================================================
  // BUILT-IN CURRICULA (Batch-Wise Prerequisite Mapping 2018 / 2020 / 2023)
  // ------------------------------------------------------------
  // These are hard-coded from the official Batch_Wise_Prerequisite_Mapping
  // spreadsheet — advisors no longer need to import a CSV.
  // The applicable curriculum is chosen automatically from the student's
  // roll number (see resolveCurriculumForRoll below).
  // ============================================================
  const CURRICULA = {
    '2018': {
      label: 'Curriculum 2018 (batches admitted 2018–2019)',
      rules: [
        { courseCode: 'MAT 103', courseTitle: 'Ordinary and Partial Differential Equations and Coordinate Geometry', prereqCode: 'MAT 101', prereqTitle: 'Differential and Integral Calculus' },
        { courseCode: 'MAT 105', courseTitle: 'Linear Algebra and Vector Analysis', prereqCode: 'MAT 101', prereqTitle: 'Differential and Integral Calculus' },
        { courseCode: 'CSE 105', courseTitle: 'Data Structures', prereqCode: 'CSE 103', prereqTitle: 'Structured Programming' },
        { courseCode: 'CSE 201', courseTitle: 'Object Oriented Programming', prereqCode: 'CSE 103', prereqTitle: 'Structured Programming' },
        { courseCode: 'CSE 205', courseTitle: 'Algorithms', prereqCode: 'CSE 105', prereqTitle: 'Data Structures' },
        { courseCode: 'EEE 203', courseTitle: 'Electronic Devices and Circuits & Pulse Techniques', prereqCode: 'EEE 201', prereqTitle: 'Introduction to Electrical Engineering' },
        { courseCode: 'CSE 211', courseTitle: 'Computer Architecture', prereqCode: 'CSE 203', prereqTitle: 'Digital Logic Design' },
        { courseCode: 'CSE 301', courseTitle: 'Web Programming', prereqCode: 'CSE 209', prereqTitle: 'Database System' },
        { courseCode: 'CSE 303', courseTitle: 'Microprocessors & Microcontrollers', prereqCode: 'CSE 203', prereqTitle: 'Digital Logic Design' },
        { courseCode: 'CSE 209', courseTitle: 'Database System', prereqCode: 'CSE 105', prereqTitle: 'Data Structures' },
        { courseCode: 'EEE 205', courseTitle: 'Electrical Drives and Instrumentation', prereqCode: 'EEE 203', prereqTitle: 'Electronic Devices and Circuits & Pulse Techniques' },
        { courseCode: 'CSE 401', courseTitle: 'Mobile Application Development', prereqCode: 'CSE 201', prereqTitle: 'Object Oriented Programming' },
        { courseCode: 'CSE 437', courseTitle: 'Information System and Design', prereqCode: 'CSE 313', prereqTitle: 'Software Engineering' }
      ]
    },
    '2020': {
      label: 'Curriculum 2020 (batches admitted 2020–2022)',
      rules: [
        { courseCode: 'MAT 103', courseTitle: 'Ordinary and Partial Differential Equations and Coordinate Geometry', prereqCode: 'MAT 101', prereqTitle: 'Differential and Integral Calculus' },
        { courseCode: 'MAT 105', courseTitle: 'Linear Algebra and Vector Analysis', prereqCode: 'MAT 101', prereqTitle: 'Differential and Integral Calculus' },
        { courseCode: 'CSE 105', courseTitle: 'Data Structures', prereqCode: 'CSE 103', prereqTitle: 'Structured Programming' },
        { courseCode: 'CSE 201', courseTitle: 'Object Oriented Programming', prereqCode: 'CSE 103', prereqTitle: 'Structured Programming' },
        { courseCode: 'CSE 205', courseTitle: 'Algorithms', prereqCode: 'CSE 105', prereqTitle: 'Data Structures' },
        { courseCode: 'EEE 203', courseTitle: 'Electronic Devices and Circuits & Pulse Techniques', prereqCode: 'EEE 201', prereqTitle: 'Introduction to Electrical Engineering' },
        { courseCode: 'CSE 211', courseTitle: 'Computer Architecture', prereqCode: 'CSE 203', prereqTitle: 'Digital Logic Design' },
        { courseCode: 'CSE 301', courseTitle: 'Web Programming', prereqCode: 'CSE 209', prereqTitle: 'Database System' },
        { courseCode: 'CSE 303', courseTitle: 'Microprocessors & Microcontrollers', prereqCode: 'CSE 203', prereqTitle: 'Digital Logic Design' },
        { courseCode: 'CSE 209', courseTitle: 'Database System', prereqCode: 'CSE 105', prereqTitle: 'Data Structures' },
        { courseCode: 'EEE 205', courseTitle: 'Electrical Drives and Instrumentation', prereqCode: 'EEE 203', prereqTitle: 'Electronic Devices and Circuits & Pulse Techniques' }
      ]
    },
    '2023': {
      label: 'Curriculum 2023 (batches admitted 2023 onwards)',
      rules: [
        { courseCode: 'MAT 0541-103', courseTitle: 'Linear Algebra and Vector Analysis', prereqCode: 'MAT 0541-101', prereqTitle: 'Calculus for Computing' },
        { courseCode: 'MAT 0541-201', courseTitle: 'Differential Equations and Coordinate Geometry', prereqCode: 'MAT 0541-101', prereqTitle: 'Calculus for Computing' },
        { courseCode: 'CSE 0613-201', courseTitle: 'Object Oriented Programming', prereqCode: 'CSE 0613-103', prereqTitle: 'Structured Programming' },
        { courseCode: 'CSE 0613-202', courseTitle: 'Object Oriented Programming Lab', prereqCode: 'CSE 0613-104', prereqTitle: 'Structured Programming Lab' },
        { courseCode: 'CSE 0613-205', courseTitle: 'Data Structures', prereqCode: 'CSE 0613-103', prereqTitle: 'Structured Programming' },
        { courseCode: 'CSE 0613-207', courseTitle: 'Algorithms', prereqCode: 'CSE 0613-205', prereqTitle: 'Data Structures' },
        { courseCode: 'CSE 0613-208', courseTitle: 'Algorithms Lab', prereqCode: 'CSE 0613-206', prereqTitle: 'Data Structures Lab' },
        { courseCode: 'CSE 0611-211', courseTitle: 'Computer Architecture', prereqCode: 'CSE 0611-203', prereqTitle: 'Digital Logic Design' },
        { courseCode: 'CSE 0613-301', courseTitle: 'Web Programming', prereqCode: 'CSE 0612-209', prereqTitle: 'Database' },
        { courseCode: 'CSE 0613-302', courseTitle: 'Web Programming Lab', prereqCode: 'CSE 0612-210', prereqTitle: 'Database Lab' },
        { courseCode: 'CSE 0611-303', courseTitle: 'Microprocessors, Microcontrollers and Embedded Systems', prereqCode: 'CSE 0611-203', prereqTitle: 'Digital Logic Design' },
        { courseCode: 'CSE 0611-304', courseTitle: 'Microprocessors, Microcontrollers and Embedded Systems Lab', prereqCode: 'CSE 0611-204', prereqTitle: 'Digital Logic Design Lab' },
        { courseCode: 'EEE 0714-201', courseTitle: 'Electrical Devices, Circuits and Pulse Techniques', prereqCode: 'EEE 0713-101', prereqTitle: 'Introduction to Electrical Engineering' },
        { courseCode: 'EEE 0714-202', courseTitle: 'Electrical Devices, Circuits and Pulse Techniques Lab', prereqCode: 'EEE 0713-102', prereqTitle: 'Introduction to Electrical Engineering Lab' }
      ]
    }
  };

  // Curriculum applicable by admission year (2-digit year prefix of roll number).
  //   18, 19          -> Curriculum 2018
  //   20, 21, 22      -> Curriculum 2020
  //   23, 24, 25, ... -> Curriculum 2023
  function curriculumKeyForAdmissionYear(yy) {
    if (yy === null || yy === undefined || isNaN(yy)) return '2023'; // safe default = latest
    if (yy <= 19) return '2018';
    if (yy <= 22) return '2020';
    return '2023';
  }

  // Extract the admission-year two-digit prefix from a GUMS roll number.
  // GUMS roll pattern (per user spec): first 2 digits = admission year,
  // 3rd digit = semester (1 or 2). Example: "241002011" -> year 24, semester 1.
  // We only need the year part for curriculum selection.
  function extractAdmissionYearFromRoll(roll) {
    if (!roll) return null;
    const digits = String(roll).replace(/\D+/g, '');
    if (digits.length < 2) return null;
    const yy = parseInt(digits.slice(0, 2), 10);
    return isNaN(yy) ? null : yy;
  }

  function resolveCurriculumForRoll(roll) {
    const yy = extractAdmissionYearFromRoll(roll);
    const key = curriculumKeyForAdmissionYear(yy);
    return { key, admissionYear: yy, ...CURRICULA[key] };
  }

  // Minimal RFC4180-style CSV line parser — still used by the remedial-list
  // importer below (the prerequisite-rules importer has been removed).
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

  // ============================================================
  // STORAGE MANAGER (prefs + remedial list + history cache)
  // Prerequisite rules are now built-in and are NOT persisted anymore.
  // ============================================================
  const StorageManager = (() => {
    const PREFS_KEY = 'gums_ui_prefs';
    const LEGACY_RULES_KEY = 'gums_prerequisite_rules'; // cleared on load — legacy from v1

    // Clear any leftover manually-imported rules from earlier versions so they
    // can never silently shadow the built-in curricula.
    try { localStorage.removeItem(LEGACY_RULES_KEY); } catch (e) { /* ignore */ }

    function normalize(code) {
      // Route through the same base-code stripping used for DOM-extracted
      // course codes, so a rule entered as "CSE 103-CSE(181)" matches a
      // completed course extracted as "CSE103".
      return extractBaseCourseCode(code);
    }

    function loadPrefs() { try { return JSON.parse(localStorage.getItem(PREFS_KEY)) || { theme: 'light' }; } catch { return { theme: 'light' }; } }
    function savePrefs(prefs) { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); }

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
      normalize, loadPrefs, savePrefs,
      getCachedCompleted, setCachedCompleted,
      loadRemedialList, saveRemedialList, clearRemedialList, importRemedialCSV, getRemedialForStudent
    };
  })();

  // ============================================================
  // PREREQUISITE ENGINE (with special rule handling)
  // ------------------------------------------------------------
  // "rules" is now always the resolved curriculum's rules for the current
  // student — never a globally-shared user-imported list.
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

    function isPanelOpen() {
      if (panelEl && !document.body.contains(panelEl)) panelEl = null;
      return !!panelEl;
    }
    let state = {
      completedCourses: [],
      selectedCourses: [],
      rules: [],                 // curriculum rules for the current student
      curriculum: null,          // { key, label, admissionYear, rules }
      debug: false,
      historyError: false,
      needsHistoryVisit: false
    };

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
        .gums-curriculum-banner { background: #e6f3d9; border: 1px solid #cbe4b3; border-radius: 6px;
          padding: 10px 14px; margin-bottom: 14px; font-size: 13px; color: #234a12; }
        .gums-curriculum-banner b { color: #0c7c3e; }
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
      state.historyError = false;
      state.needsHistoryVisit = false;
      state.selectedCourses = extractSelectedCourses() || [];
      const roll = extractStudentRoll();
      if (!roll) {
        state.completedCourses = [];
        state.curriculum = null;
        state.rules = [];
        state.historyError = true; // couldn't even find the student's roll on the page
        return;
      }
      // Auto-select the curriculum from the student's roll number.
      state.curriculum = resolveCurriculumForRoll(roll);
      state.rules = state.curriculum.rules;

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

    function curriculumBannerHTML() {
      if (!state.curriculum) return '';
      const yy = state.curriculum.admissionYear;
      const yearText = yy !== null && !isNaN(yy) ? `20${String(yy).padStart(2, '0')}` : 'unknown';
      return `<div class="gums-curriculum-banner">
        📘 Applied curriculum: <b>${state.curriculum.label}</b>
        &nbsp;·&nbsp; auto-selected from roll number (admission year <b>${yearText}</b>)
        &nbsp;·&nbsp; <b>${state.rules.length}</b> built-in prerequisite rule(s)
      </div>`;
    }

    function renderSummaryTab() {
      const stats = computeStats();
      const totalCredits = PrerequisiteEngine.calculateTotalCredits(state.completedCourses);
      const el = document.createElement('div');
      el.innerHTML = `
        ${curriculumBannerHTML()}
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
      el.innerHTML = curriculumBannerHTML();
      const courseCodes = PrerequisiteEngine.getAllCourseCodesWithRules(state.rules);
      if (courseCodes.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'gums-empty';
        empty.innerHTML = 'No prerequisite rules found for this curriculum.';
        el.appendChild(empty);
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
      el.innerHTML = curriculumBannerHTML();
      const codes = PrerequisiteEngine.getAllCourseCodesWithRules(state.rules);
      const ineligible = codes.filter(c => !PrerequisiteEngine.checkPrerequisites(c, state.rules, state.completedCourses).eligible);
      if (ineligible.length === 0) {
        const ok = document.createElement('div');
        ok.className = 'gums-empty';
        ok.textContent = 'No ineligible courses — nice.';
        el.appendChild(ok);
        return el;
      }
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

    function renderCurriculumTab() {
      const el = document.createElement('div');
      el.innerHTML = `
        ${curriculumBannerHTML()}
        <div style="font-size:12px;color:#555;margin-bottom:14px;line-height:1.6;">
          The applicable curriculum is <b>hard-coded</b> and selected automatically from the student's admission year (first two digits of the roll number):
          <ul style="margin:6px 0 0 18px;padding:0;">
            <li>Roll starts with <b>18</b> or <b>19</b> &nbsp;→&nbsp; Curriculum 2018</li>
            <li>Roll starts with <b>20</b>, <b>21</b> or <b>22</b> &nbsp;→&nbsp; Curriculum 2020</li>
            <li>Roll starts with <b>23</b> or later &nbsp;→&nbsp; Curriculum 2023</li>
          </ul>
        </div>
        <h4>Special Rules (built-in, apply to all curricula)</h4>
        <div style="font-size:12px;color:#555;margin-bottom:14px;">
          <div class="gums-special-rule ok">✓ CSE 400a: Requires at least 100 completed credits</div>
          <div class="gums-special-rule ok">✓ CSE 300b: Requires CSE 400a (completed or in progress)</div>
          <div class="gums-special-rule ok">✓ CSE 400c: Requires both CSE 400a and CSE 400b (completed or in progress)</div>
        </div>
        <hr style="margin:18px 0;">
        <h4>Active prerequisite rules — ${state.curriculum ? state.curriculum.label : '(no student detected)'} (${state.rules.length})</h4>
        <div id="gums-rules-list"></div>
        <hr style="margin:18px 0;">
        <details><summary style="cursor:pointer;font-size:13px;color:#0c7c3e;">Show all built-in curricula</summary>
          <div id="gums-all-curricula" style="margin-top:10px;"></div>
        </details>
      `;

      const list = el.querySelector('#gums-rules-list');
      if (!state.rules.length) {
        list.innerHTML = '<div class="gums-empty">No rules — is a student loaded on the registration page?</div>';
      } else {
        state.rules.forEach(r => {
          const row = document.createElement('div');
          row.className = 'gums-rule-row';
          row.innerHTML = `<span>${r.courseCode} (${r.courseTitle || '—'})</span><span>requires</span><span>${r.prereqCode} (${r.prereqTitle || '—'})</span>`;
          list.appendChild(row);
        });
      }

      const all = el.querySelector('#gums-all-curricula');
      Object.keys(CURRICULA).forEach(key => {
        const cur = CURRICULA[key];
        const wrap = document.createElement('div');
        wrap.style.marginBottom = '14px';
        const heading = document.createElement('div');
        heading.style.cssText = 'font-weight:bold;color:#0c7c3e;margin-bottom:6px;';
        heading.textContent = `${cur.label} — ${cur.rules.length} rule(s)`;
        wrap.appendChild(heading);
        cur.rules.forEach(r => {
          const row = document.createElement('div');
          row.className = 'gums-rule-row';
          row.innerHTML = `<span>${r.courseCode} (${r.courseTitle || '—'})</span><span>requires</span><span>${r.prereqCode} (${r.prereqTitle || '—'})</span>`;
          wrap.appendChild(row);
        });
        all.appendChild(wrap);
      });

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

    const TABS = [
      { id: 'summary', label: 'Summary', render: renderSummaryTab },
      { id: 'analysis', label: 'Prerequisite Analysis', render: renderAnalysisTab },
      { id: 'ineligible', label: 'Missing Prerequisites', render: renderIneligibleTab },
      { id: 'nonpassing', label: 'F / I / AB', render: renderNonPassingTab },
      { id: 'remedial', label: 'Remedial (EAP/MAT)', render: renderRemedialTab },
      { id: 'curriculum', label: 'Curriculum', render: renderCurriculumTab },
    ];
    let activeTab = 'summary';

    function renderBody() {
      if (!isPanelOpen()) return;
      // Always refresh curriculum/rules from the resolved student — advisor may
      // have switched to another student via a partial postback since the last render.
      const roll = extractStudentRoll();
      if (roll) {
        state.curriculum = resolveCurriculumForRoll(roll);
        state.rules = state.curriculum.rules;
      }
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
          <div class="code" style="margin-bottom:10px;color:#777;">${courseCode}${state.curriculum ? ' &nbsp;·&nbsp; ' + state.curriculum.label : ''}</div>
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
        <div class="gums-disclaimer">⚠ <b>Advisory tool only —</b> prerequisite rules are hard-coded from the Batch-Wise Prerequisite Mapping (2018 / 2020 / 2023) and the curriculum is auto-selected from the student's roll number. Remedial data and result-history caching are still maintained manually and may be incomplete or outdated. Always verify against the official GUMS record and result history before approving or rejecting a course. &nbsp;·&nbsp; <a href="${SOURCE_URL}" target="_blank" rel="noopener noreferrer" style="color:#0c7c3e;">Source code ↗</a></div>
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
      console.info('[GUMS] Prerequisite rules are built-in (curricula 2018 / 2020 / 2023). Curriculum auto-selects from the student roll number.');
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
