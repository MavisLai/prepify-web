// gradebook/js/student.js

(function () {
  function getClient() {
    const client = window.supabaseClient || window.supabase;
    if (!client) throw new Error('Supabase client is not initialized.');
    return client;
  }

  function normalizeArray(val) {
    if (Array.isArray(val)) return val;
    if (typeof val === 'string') {
      try {
        const parsed = JSON.parse(val);
        if (Array.isArray(parsed)) return parsed;
      } catch (_) {
        if (val.trim()) return [val.trim()];
      }
    }
    return [];
  }

  async function initStudentSession() {
    const session = window.PrepifyAuth.requireStudent();
    if (!session) return null;

    const sb = getClient();
    const { data: freshStudent } = await sb
      .from('students')
      .select('id, name, username, grade, class_id')
      .eq('id', session.id)
      .single();

    if (freshStudent) {
      const updated = {
        ...session,
        name: freshStudent.name,
        username: freshStudent.username,
        grade: freshStudent.grade || 'Grade 8',
        classId: freshStudent.class_id
      };
      localStorage.setItem('prepify_student_session', JSON.stringify(updated));
      return updated;
    }

    return session;
  }

  async function loadStudentWorkspace(studentSession) {
    const sb = getClient();

    let classInfo = null;
    if (studentSession.classId) {
      const { data: cls } = await sb
        .from('classes')
        .select('id, name, schedule, join_code')
        .eq('id', studentSession.classId)
        .single();
      classInfo = cls || null;
    }

    const { data: allAssignRows, error: assignErr } = await sb
      .from('assignments')
      .select('*')
      .order('created_at', { ascending: false });

    if (assignErr) throw assignErr;

    const assignments = (allAssignRows || []).filter(a => {
      const rawIds = normalizeArray(a.question_ids);
      if (rawIds.includes('ARCHIVED')) return false;

      const targetStudents = normalizeArray(a.student_ids);
      const matchesClass = studentSession.classId && a.class_id === studentSession.classId;
      const matchesStudent = targetStudents.includes(studentSession.id);
      return matchesClass || matchesStudent;
    });

    const { data: questionRows, error: qErr } = await sb
      .from('questions')
      .select('*')
      .eq('status', 'Published');

    if (qErr) throw qErr;

    const questionsById = {};
    const allPublishedQuestions = (questionRows || []).map(q => {
      const gradesArr = normalizeArray(q.grades);
      const formatted = {
        id: q.id,
        subject: q.subject,
        grades: gradesArr.length > 0 ? gradesArr : ['Grade 8', 'Grade 9'],
        type: q.type,
        topic: q.topic,
        subtopic: q.subtopic || '',
        difficulty: String(q.difficulty || '525'),
        prompt: q.prompt,
        config: q.config || {},
        explanation: q.explanation || ''
      };
      questionsById[q.id] = formatted;
      return formatted;
    });

    const { data: attemptRows, error: attErr } = await sb
      .from('student_attempts')
      .select('*, assignments(title), questions(topic, subject, prompt)')
      .eq('student_id', studentSession.id)
      .order('created_at', { ascending: false });

    if (attErr) throw attErr;
    const attempts = attemptRows || [];

    const hydratedAssignments = assignments.map(a => {
      const rawIds = normalizeArray(a.question_ids);
      const adaptiveMarker = rawIds.find(id => typeof id === 'string' && id.startsWith('ADAPTIVE'));
      const titleLooksAdaptive = typeof a.title === 'string' && a.title.toLowerCase().includes('adaptive');

      const isAdaptive =
        a.test_type === 'full_adaptive_simulation' ||
        Boolean(adaptiveMarker) ||
        (rawIds.length === 0 && titleLooksAdaptive);

      let adaptiveCount = 20;
      let targetGrade = a.target_grade || 'Both';
      if (adaptiveMarker) {
        const parts = adaptiveMarker.split(':');
        if (parts[1]) adaptiveCount = parseInt(parts[1], 10) || 20;
        if (parts[2]) targetGrade = parts[2];
      }

      const qList = isAdaptive
        ? []
        : rawIds.map(qid => questionsById[qid]).filter(Boolean);

      const expectedLen = isAdaptive ? adaptiveCount : qList.length;
      const aAttempts = attempts.filter(att => att.assignment_id === a.id);
      const completed = expectedLen > 0 && aAttempts.length >= expectedLen;
      const correctCount = aAttempts.filter(att => att.is_correct).length;

      return {
        id: a.id,
        title: a.title,
        testType: isAdaptive ? 'full_adaptive_simulation' : (a.test_type || 'topic_test'),
        isAdaptive,
        adaptiveCount,
        timeLimitMinutes: a.time_limit_minutes || null,
        targetGrade,
        createdAt: a.created_at,
        questions: qList,
        completed,
        scoreText: aAttempts.length > 0
          ? `${Math.round((correctCount / aAttempts.length) * 100)}% (${correctCount}/${aAttempts.length})`
          : null
      };
    });

    return {
      classInfo,
      assignments: hydratedAssignments,
      publishedQuestions: allPublishedQuestions,
      attempts
    };
  }

  async function joinClassByCode(studentId, joinCode) {
    const sb = getClient();
    const cleanCode = joinCode.trim().toUpperCase();

    const { data: cls, error: findErr } = await sb
      .from('classes')
      .select('id, name, schedule, join_code')
      .eq('join_code', cleanCode)
      .single();

    if (findErr || !cls) {
      throw new Error('Class join code not found. Double-check the code with your instructor.');
    }

    const { error: updErr } = await sb
      .from('students')
      .update({ class_id: cls.id })
      .eq('id', studentId);

    if (updErr) throw updErr;

    const current = window.PrepifyAuth.getCurrentStudent();
    if (current) {
      current.classId = cls.id;
      localStorage.setItem('prepify_student_session', JSON.stringify(current));
    }

    return cls;
  }

  async function recordAttempts(studentId, assignmentId, resultsList) {
    const sb = getClient();
    const rows = resultsList.map(r => ({
      student_id: studentId,
      assignment_id: assignmentId || null,
      question_id: r.questionId,
      is_correct: Boolean(r.isCorrect),
      score_summary: r.scoreSummary || (r.isCorrect ? 'Correct' : 'Incorrect')
    }));

    const { error } = await sb.from('student_attempts').insert(rows);
    if (error) throw error;
    return true;
  }

  window.PrepifyStudentDB = {
    initStudentSession,
    loadStudentWorkspace,
    joinClassByCode,
    recordAttempts
  };
})();