// gradebook/js/student.js

(function () {
  function getClient() {
    const client = window.supabaseClient || window.supabase;
    if (!client) throw new Error('Supabase client is not initialized.');
    return client;
  }

  const TEST_TYPE_LABELS = {
    diagnostic_test: 'Diagnostic Test',
    topic_test: 'Topic Test',
    ela_test: 'ELA Test',
    math_test: 'Math Test',
    full_adaptive_simulation: 'Full Adaptive Simulation'
  };

  function parseAssignmentMetadata(asgn) {
    const rawIds = Array.isArray(asgn.question_ids) ? asgn.question_ids : [];
    const metaTag = rawIds.find(id => typeof id === 'string' && id.startsWith('META:'));
    const adaptiveMarker = rawIds.find(id => typeof id === 'string' && id.startsWith('ADAPTIVE:'));
    const isArchived = rawIds.includes('ARCHIVED');

    let timeLimitMinutes = asgn.time_limit_minutes ? parseInt(asgn.time_limit_minutes, 10) : null;
    let testType = asgn.test_type || 'diagnostic_test';
    let targetGrade = asgn.target_grade || 'Both';

    if (metaTag) {
      metaTag.split(':').slice(1).forEach(pair => {
        const [k, v] = pair.split('=');
        if (k === 'time' && !timeLimitMinutes) {
          const parsed = parseInt(v, 10);
          if (parsed > 0) timeLimitMinutes = parsed;
        } else if (k === 'type' && v) {
          testType = v;
        } else if (k === 'grade' && v) {
          targetGrade = v;
        }
      });
    }

    let isAdaptive = testType === 'full_adaptive_simulation' || Boolean(adaptiveMarker);
    let adaptiveCount = 20;
    if (adaptiveMarker) {
      const parts = adaptiveMarker.split(':');
      if (parts[1]) adaptiveCount = parseInt(parts[1], 10) || 20;
      if (parts[2]) targetGrade = parts[2];
    }

    const questionIds = rawIds.filter(
      id =>
        typeof id === 'string' &&
        id !== 'ARCHIVED' &&
        !id.startsWith('META:') &&
        !id.startsWith('ADAPTIVE:')
    );

    return {
      isArchived,
      isAdaptive,
      adaptiveCount,
      timeLimitMinutes,
      testType,
      testTypeLabel: TEST_TYPE_LABELS[testType] || 'Assigned Test',
      targetGrade,
      questionIds
    };
  }

  async function initStudentSession() {
    const session = window.PrepifyAuth.requireStudent();
    if (!session) return null;

    const sb = getClient();
    const { data: studentRow } = await sb
      .from('students')
      .select('id, name, username, class_id, grade, classes(id, name, join_code)')
      .eq('id', session.id)
      .single();

    if (!studentRow) return session;

    return {
      ...session,
      name: studentRow.name,
      username: studentRow.username,
      classId: studentRow.class_id,
      className: studentRow.classes?.name || 'Unassigned',
      joinCode: studentRow.classes?.join_code || '',
      grade: studentRow.grade || 'Grade 8'
    };
  }

  async function loadStudentWorkspace(studentSession) {
    const sb = getClient();

    const [
      { data: questionRows, error: qErr },
      { data: attemptRows, error: attErr },
      { data: assignmentRows, error: assignErr }
    ] = await Promise.all([
      sb.from('questions').select('*').eq('status', 'Published').order('created_at', { ascending: false }),
      sb.from('student_attempts').select('*, questions(topic, subject, prompt)').eq('student_id', studentSession.id).order('created_at', { ascending: false }),
      sb.from('assignments').select('*').order('created_at', { ascending: false })
    ]);

    if (qErr) throw qErr;
    if (attErr) throw attErr;
    if (assignErr) throw assignErr;

    const questions = (questionRows || []).map(q => ({
      id: q.id,
      subject: q.subject,
      grades: Array.isArray(q.grades) ? q.grades : ['Grade 8'],
      type: q.type,
      topic: q.topic,
      subtopic: q.subtopic || '',
      difficulty: String(q.difficulty || '525'),
      status: q.status,
      prompt: q.prompt,
      config: q.config || {},
      explanation: q.explanation || ''
    }));

    const questionById = new Map(questions.map(q => [q.id, q]));
    const attempts = attemptRows || [];

    const totalAnswered = attempts.length;
    const correctCount = attempts.filter(a => a.is_correct).length;
    const avgAccuracy = totalAnswered > 0 ? Math.round((correctCount / totalAnswered) * 100) : null;

    const elaAttempts = attempts.filter(a => a.questions?.subject === 'ELA');
    const mathAttempts = attempts.filter(a => a.questions?.subject === 'Math');
    const elaAccuracy = elaAttempts.length > 0
      ? Math.round((elaAttempts.filter(a => a.is_correct).length / elaAttempts.length) * 100)
      : null;
    const mathAccuracy = mathAttempts.length > 0
      ? Math.round((mathAttempts.filter(a => a.is_correct).length / mathAttempts.length) * 100)
      : null;

    const topicMap = {};
    attempts.forEach(a => {
      const topicName = a.questions?.topic || 'General';
      const subjectName = a.questions?.subject || '';
      const key = `${topicName}__${subjectName}`;
      if (!topicMap[key]) {
        topicMap[key] = {
          topic: topicName,
          subject: subjectName,
          total: 0,
          correct: 0
        };
      }
      topicMap[key].total += 1;
      if (a.is_correct) topicMap[key].correct += 1;
    });

    const topicAccuracy = Object.values(topicMap).map(item => ({
      topic: item.topic,
      subject: item.subject,
      total: item.total,
      correct: item.correct,
      accuracy: Math.round((item.correct / item.total) * 100)
    }));

    // Group student's attempts by assignment_id
    const attemptsByAssignment = {};
    attempts.forEach(a => {
      if (!a.assignment_id) return;
      if (!attemptsByAssignment[a.assignment_id]) {
        attemptsByAssignment[a.assignment_id] = [];
      }
      attemptsByAssignment[a.assignment_id].push(a);
    });

    // All assignments targeting this student or their class (that still exist in DB)
    const studentScopedAssignments = (assignmentRows || []).filter(asgn => {
      const matchesClass = asgn.class_id && studentSession.classId && asgn.class_id === studentSession.classId;
      const matchesStudent = Array.isArray(asgn.student_ids) && asgn.student_ids.includes(studentSession.id);
      return Boolean(matchesClass || matchesStudent);
    });

    const activeAssignments = [];
    const completedAssignments = [];

    studentScopedAssignments.forEach(asgn => {
      const meta = parseAssignmentMetadata(asgn);
      const asgnAttempts = attemptsByAssignment[asgn.id] || [];

      // Collect topic names from assigned questions or attempted questions
      const topicSet = new Set();
      meta.questionIds.forEach(qid => {
        const q = questionById.get(qid);
        if (q?.topic) topicSet.add(q.topic);
      });
      asgnAttempts.forEach(a => {
        if (a.questions?.topic) topicSet.add(a.questions.topic);
      });

      const enriched = {
        ...asgn,
        meta,
        topics: Array.from(topicSet)
      };

      if (asgnAttempts.length > 0) {
        const plannedTotal = meta.isAdaptive
          ? Math.max(asgnAttempts.length, meta.adaptiveCount)
          : Math.max(asgnAttempts.length, meta.questionIds.length);
        const rightCount = asgnAttempts.filter(a => a.is_correct).length;
        const scorePercent = Math.round((rightCount / Math.max(1, plannedTotal)) * 100);
        const latestAttemptDate = asgnAttempts[0]?.created_at
          ? new Date(asgnAttempts[0].created_at).toLocaleDateString()
          : '';

        completedAssignments.push({
          ...enriched,
          correctCount: rightCount,
          totalQuestions: plannedTotal,
          scorePercent,
          completedDate: latestAttemptDate
        });
      } else if (!meta.isArchived) {
        activeAssignments.push(enriched);
      }
    });

    return {
      questions,
      attempts,
      assignments: activeAssignments,
      completedAssignments,
      stats: {
        totalAnswered,
        correctCount,
        avgAccuracy,
        elaAccuracy,
        mathAccuracy,
        topicAccuracy
      }
    };
  }

  async function recordAttempt({ studentId, questionId, assignmentId = null, isCorrect }) {
    const sb = getClient();
    const { data, error } = await sb
      .from('student_attempts')
      .insert([{
        student_id: studentId,
        question_id: questionId,
        assignment_id: assignmentId,
        is_correct: Boolean(isCorrect)
      }])
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async function joinClassByCode(studentId, joinCode) {
    const sb = getClient();
    const cleaned = String(joinCode || '').trim().toUpperCase();
    const { data: cls, error: clsErr } = await sb
      .from('classes')
      .select('id, name, join_code')
      .eq('join_code', cleaned)
      .single();

    if (clsErr || !cls) {
      throw new Error('Class join code not found.');
    }

    const { error: updErr } = await sb
      .from('students')
      .update({ class_id: cls.id })
      .eq('id', studentId);

    if (updErr) throw updErr;
    return cls;
  }

  window.PrepifyStudentDB = {
    initStudentSession,
    loadStudentWorkspace,
    recordAttempt,
    joinClassByCode
  };
})();