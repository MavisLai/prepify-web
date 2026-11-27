// gradebook/js/teacher.js

(function () {
  function getClient() {
    const client = window.supabaseClient || window.supabase;
    if (!client) throw new Error('Supabase client is not initialized.');
    return client;
  }

  async function initTeacherSession() {
    const session = window.PrepifyAuth.requireTeacher();
    if (!session) return null;

    const sb = getClient();
    const { data: teacherRow } = await sb
      .from('teachers')
      .select('id, display_name, email')
      .eq('id', session.id)
      .single();

    if (teacherRow?.display_name) {
      localStorage.setItem('prepify_instructor_name', teacherRow.display_name);
    }

    return {
      ...session,
      displayName: teacherRow?.display_name || localStorage.getItem('prepify_instructor_name') || 'Instructor'
    };
  }

  async function updateInstructorName(newName) {
    const session = window.PrepifyAuth.getCurrentTeacher();
    if (!session?.id) return;

    const sb = getClient();
    const { error } = await sb
      .from('teachers')
      .update({ display_name: newName })
      .eq('id', session.id);

    if (error) throw error;
    localStorage.setItem('prepify_instructor_name', newName);
  }

  function computeAggregateStats(attemptList) {
    const totalAnswered = attemptList.length;
    const correctCount = attemptList.filter(a => a.is_correct).length;
    const avgAccuracy = totalAnswered > 0
      ? Math.round((correctCount / totalAnswered) * 100)
      : null;

    const elaAttempts = attemptList.filter(a => a.questions?.subject === 'ELA');
    const mathAttempts = attemptList.filter(a => a.questions?.subject === 'Math');

    const elaAccuracy = elaAttempts.length > 0
      ? Math.round((elaAttempts.filter(a => a.is_correct).length / elaAttempts.length) * 100)
      : null;
    const mathAccuracy = mathAttempts.length > 0
      ? Math.round((mathAttempts.filter(a => a.is_correct).length / mathAttempts.length) * 100)
      : null;

    const topicMap = {};
    attemptList.forEach(a => {
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

    return {
      totalAnswered,
      elaAccuracy,
      mathAccuracy,
      avgAccuracy,
      topicAccuracy
    };
  }

  async function loadTeacherWorkspace() {
    const sb = getClient();

    const [
      { data: classRows, error: classErr },
      { data: studentRows, error: studErr },
      { data: questionRows, error: qErr },
      { data: attemptRows, error: attErr },
      { data: assignmentRows, error: assignErr }
    ] = await Promise.all([
      sb.from('classes').select('*').order('created_at', { ascending: true }),
      sb.from('students').select('*').order('created_at', { ascending: true }),
      sb.from('questions').select('*').order('created_at', { ascending: false }),
      sb.from('student_attempts').select('*, assignments(title), questions(topic, subject, prompt)').order('created_at', { ascending: false }),
      sb.from('assignments').select('*').order('created_at', { ascending: false })
    ]);

    if (classErr) throw classErr;
    if (studErr) throw studErr;
    if (qErr) throw qErr;
    if (attErr) throw attErr;
    if (assignErr) throw assignErr;

    const attempts = attemptRows || [];
    const rawStudents = studentRows || [];

    const classes = (classRows || []).map(c => {
      const classStudentIds = new Set(
        rawStudents.filter(s => s.class_id === c.id).map(s => s.id)
      );
      const classAttempts = attempts.filter(a => classStudentIds.has(a.student_id));
      const classStats = computeAggregateStats(classAttempts);

      return {
        id: c.id,
        name: c.name,
        schedule: c.schedule || '',
        joinCode: c.join_code,
        studentCount: classStudentIds.size,
        results: classStats
      };
    });

    const questions = (questionRows || []).map(q => {
      const qAttempts = attempts.filter(a => a.question_id === q.id);
      const correctCount = qAttempts.filter(a => a.is_correct).length;
      return {
        id: q.id,
        subject: q.subject,
        grades: Array.isArray(q.grades) ? q.grades : ['Grade 8'],
        type: q.type,
        topic: q.topic,
        subtopic: q.subtopic || '',
        difficulty: String(q.difficulty || '525'),
        status: q.status || 'Published',
        accuracy: qAttempts.length > 0 ? Math.round((correctCount / qAttempts.length) * 100) : null,
        uses: qAttempts.length,
        prompt: q.prompt,
        config: q.config || {},
        explanation: q.explanation || ''
      };
    });

    const students = rawStudents.map(s => {
      const sAttempts = attempts.filter(a => a.student_id === s.id);
      const stats = computeAggregateStats(sAttempts);

      const elaScore = stats.elaAccuracy !== null ? `${stats.elaAccuracy}%` : null;
      const mathScore = stats.mathAccuracy !== null ? `${stats.mathAccuracy}%` : null;

      const missedQuestions = sAttempts
        .filter(a => !a.is_correct && a.questions)
        .slice(0, 10)
        .map(a => ({
          topic: a.questions.topic,
          subject: a.questions.subject,
          prompt: a.questions.prompt,
          date: new Date(a.created_at).toLocaleDateString()
        }));

      const byAssignment = {};
      sAttempts.forEach(a => {
        if (!a.assignment_id) return;
        if (!byAssignment[a.assignment_id]) {
          byAssignment[a.assignment_id] = {
            title: a.assignments?.title || 'Assigned Test',
            total: 0,
            correct: 0,
            date: new Date(a.created_at).toLocaleDateString()
          };
        }
        byAssignment[a.assignment_id].total += 1;
        if (a.is_correct) byAssignment[a.assignment_id].correct += 1;
      });
      const tests = Object.values(byAssignment).map(t => ({
        title: t.title,
        score: `${Math.round((t.correct / t.total) * 100)}% (${t.correct}/${t.total})`,
        date: t.date
      }));

      return {
        id: s.id,
        name: s.name,
        username: s.username,
        classId: s.class_id,
        grade: s.grade || 'Grade 8',
        results: {
          elaScore,
          mathScore,
          avgAccuracy: stats.avgAccuracy,
          topicAccuracy: stats.topicAccuracy,
          missedQuestions,
          tests
        }
      };
    });

    return {
      classes,
      students,
      questions,
      assignments: assignmentRows || []
    };
  }

  async function createClass(name, schedule, joinCode) {
    const sb = getClient();
    const { data, error } = await sb
      .from('classes')
      .insert([{ name, schedule, join_code: joinCode }])
      .select()
      .single();

    if (error) throw error;
    return {
      id: data.id,
      name: data.name,
      schedule: data.schedule || '',
      joinCode: data.join_code,
      studentCount: 0,
      results: {
        totalAnswered: 0,
        elaAccuracy: null,
        mathAccuracy: null,
        avgAccuracy: null,
        topicAccuracy: []
      }
    };
  }

  async function createStudent({ name, username, classId, grade, passcode }) {
    const sb = getClient();
    const { data, error } = await sb
      .from('students')
      .insert([{
        name,
        username: username.toLowerCase(),
        class_id: classId || null,
        grade: grade || 'Grade 8',
        passcode
      }])
      .select()
      .single();

    if (error) throw error;
    return {
      id: data.id,
      name: data.name,
      username: data.username,
      classId: data.class_id,
      grade: data.grade,
      results: {
        elaScore: null,
        mathScore: null,
        avgAccuracy: null,
        topicAccuracy: [],
        missedQuestions: [],
        tests: []
      }
    };
  }

  async function resetStudentPasscode(studentId, newPasscode) {
    const sb = getClient();
    const { error } = await sb
      .from('students')
      .update({ passcode: newPasscode })
      .eq('id', studentId);

    if (error) throw error;
    return true;
  }

  async function upsertQuestion(item) {
    const sb = getClient();
    const payload = {
      id: item.id,
      subject: item.subject,
      grades: item.grades,
      type: item.type,
      topic: item.topic,
      subtopic: item.subtopic || '',
      difficulty: String(item.difficulty),
      status: item.status,
      prompt: item.prompt,
      config: item.config,
      explanation: item.explanation
    };

    const { data, error } = await sb
      .from('questions')
      .upsert(payload)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async function deleteQuestion(questionId) {
    const sb = getClient();
    const { error } = await sb.from('questions').delete().eq('id', questionId);
    if (error) throw error;
    return true;
  }

  async function createAssignment(title, classId, questionIdSet) {
    const sb = getClient();
    const { data, error } = await sb
      .from('assignments')
      .insert([{
        title,
        class_id: classId,
        question_ids: Array.from(questionIdSet)
      }])
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async function createTestAssignment({
    title,
    testType,
    timeLimitMinutes,
    targetGrade,
    assignTargetType,
    classId,
    studentIds,
    questionIds,
    adaptiveQuestionCount
  }) {
    const sb = getClient();
    const isAdaptive = testType === 'full_adaptive_simulation';
    const storedQuestionIds = isAdaptive
      ? [`ADAPTIVE:${adaptiveQuestionCount || 20}:${targetGrade || 'Both'}`]
      : questionIds;

    const payload = {
      title,
      class_id: assignTargetType === 'class' ? (classId || null) : null,
      student_ids: assignTargetType === 'students' ? studentIds : [],
      question_ids: storedQuestionIds,
      test_type: testType,
      time_limit_minutes: timeLimitMinutes || null,
      target_grade: targetGrade || 'Both'
    };

    let { data, error } = await sb
      .from('assignments')
      .insert([payload])
      .select()
      .single();

    if (error && error.message && error.message.includes('column')) {
      const fallbackPayload = {
        title,
        class_id: assignTargetType === 'class' ? (classId || null) : null,
        student_ids: assignTargetType === 'students' ? studentIds : [],
        question_ids: storedQuestionIds
      };
      const retry = await sb.from('assignments').insert([fallbackPayload]).select().single();
      data = retry.data;
      error = retry.error;
    }

    if (error) throw error;
    return data;
  }

  async function archiveAssignment(assignmentId) {
    const sb = getClient();
    const { data: row, error: fetchErr } = await sb
      .from('assignments')
      .select('question_ids')
      .eq('id', assignmentId)
      .single();
    if (fetchErr) throw fetchErr;

    const currentIds = Array.isArray(row?.question_ids) ? row.question_ids : [];
    const nextIds = currentIds.includes('ARCHIVED') ? currentIds : ['ARCHIVED', ...currentIds];

    const { error } = await sb
      .from('assignments')
      .update({ question_ids: nextIds })
      .eq('id', assignmentId);
    if (error) throw error;
    return nextIds;
  }

  async function reassignAssignment(assignmentId) {
    const sb = getClient();
    const { data: row, error: fetchErr } = await sb
      .from('assignments')
      .select('question_ids')
      .eq('id', assignmentId)
      .single();
    if (fetchErr) throw fetchErr;

    const currentIds = Array.isArray(row?.question_ids) ? row.question_ids : [];
    const nextIds = currentIds.filter(id => id !== 'ARCHIVED');

    const { error } = await sb
      .from('assignments')
      .update({
        question_ids: nextIds,
        created_at: new Date().toISOString()
      })
      .eq('id', assignmentId);
    if (error) throw error;
    return nextIds;
  }

  async function permanentlyDeleteAssignment(assignmentId) {
    const sb = getClient();
    await sb.from('student_attempts').delete().eq('assignment_id', assignmentId);
    const { error } = await sb.from('assignments').delete().eq('id', assignmentId);
    if (error) throw error;
    return true;
  }

  window.PrepifyTeacherDB = {
    initTeacherSession,
    updateInstructorName,
    loadTeacherWorkspace,
    createClass,
    createStudent,
    resetStudentPasscode,
    upsertQuestion,
    deleteQuestion,
    createAssignment,
    createTestAssignment,
    archiveAssignment,
    reassignAssignment,
    permanentlyDeleteAssignment
  };
})();