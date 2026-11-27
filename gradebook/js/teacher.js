// gradebook/js/teacher.js

(function () {
  function getClient() {
    const client = window.supabaseClient || window.supabase;
    if (!client) throw new Error('Supabase client is not initialized.');
    return client;
  }

  let currentTeacherUser = null;

  async function initTeacherSession() {
    const user = await window.PrepifyAuth.requireTeacher();
    if (!user) return null;
    currentTeacherUser = user;

    const sb = getClient();
    const fallbackName =
      user.user_metadata?.display_name ||
      localStorage.getItem('prepify_instructor_name') ||
      user.email?.split('@')[0] ||
      'Instructor';

    const { data: existingProfile } = await sb
      .from('profiles')
      .select('display_name')
      .eq('id', user.id)
      .single();

    if (!existingProfile) {
      await sb.from('profiles').upsert({
        id: user.id,
        email: user.email,
        display_name: fallbackName,
        role: 'teacher'
      });
    }

    const activeName = existingProfile?.display_name || fallbackName;
    localStorage.setItem('prepify_instructor_name', activeName);
    return { user, displayName: activeName };
  }

  async function loadTeacherWorkspace() {
    if (!currentTeacherUser) await initTeacherSession();
    if (!currentTeacherUser) return null;

    const sb = getClient();
    const tid = currentTeacherUser.id;

    const [classesRes, studentsRes, questionsRes, attemptsRes] = await Promise.all([
      sb.from('classes').select('*').eq('teacher_id', tid).order('created_at', { ascending: true }),
      sb.from('students').select('*').eq('teacher_id', tid).order('created_at', { ascending: true }),
      sb.from('questions').select('*').eq('teacher_id', tid).order('created_at', { ascending: false }),
      sb.from('student_attempts').select('*, assignments(title), questions(topic, subject, prompt)').order('created_at', { ascending: false })
    ]);

    if (classesRes.error) throw classesRes.error;
    if (studentsRes.error) throw studentsRes.error;
    if (questionsRes.error) throw questionsRes.error;

    const classes = (classesRes.data || []).map(c => ({
      id: c.id,
      name: c.name,
      schedule: c.schedule || '',
      joinCode: c.join_code
    }));

    const questions = (questionsRes.data || []).map(q => {
      const qAttempts = (attemptsRes.data || []).filter(a => a.question_id === q.id);
      const uses = qAttempts.length;
      const correctCount = qAttempts.filter(a => a.is_correct).length;
      const accuracy = uses > 0 ? Math.round((correctCount / uses) * 100) : null;

      return {
        id: q.id,
        subject: q.subject,
        grades: q.grades || ['Grade 8'],
        type: q.type,
        topic: q.topic,
        subtopic: q.subtopic || '',
        difficulty: String(q.difficulty),
        status: q.status || 'Published',
        accuracy,
        uses,
        prompt: q.prompt,
        config: q.config || {},
        explanation: q.explanation || ''
      };
    });

    const students = (studentsRes.data || []).map(s => {
      const sAttempts = (attemptsRes.data || []).filter(a => a.student_id === s.id);
      const total = sAttempts.length;
      const correct = sAttempts.filter(a => a.is_correct).length;
      const avgAccuracy = total > 0 ? Math.round((correct / total) * 100) : null;

      const topicMap = {};
      sAttempts.forEach(att => {
        const topic = att.questions?.topic || 'General';
        if (!topicMap[topic]) topicMap[topic] = { total: 0, correct: 0 };
        topicMap[topic].total += 1;
        if (att.is_correct) topicMap[topic].correct += 1;
      });
      const topicAccuracy = Object.entries(topicMap).map(([topic, stats]) => ({
        topic,
        accuracy: Math.round((stats.correct / stats.total) * 100)
      }));

      const missedQuestions = sAttempts
        .filter(att => !att.is_correct)
        .slice(0, 10)
        .map(att => ({
          id: att.question_id,
          topic: att.questions?.topic || 'Topic',
          subject: att.questions?.subject || 'Math',
          prompt: att.questions?.prompt || '',
          date: new Date(att.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        }));

      const testMap = {};
      sAttempts.forEach(att => {
        const key = att.assignment_id || 'practice';
        if (!testMap[key]) {
          testMap[key] = {
            title: att.assignments?.title || 'Practice Set',
            total: 0,
            correct: 0,
            date: new Date(att.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
          };
        }
        testMap[key].total += 1;
        if (att.is_correct) testMap[key].correct += 1;
      });
      const tests = Object.values(testMap).map(t => ({
        title: t.title,
        score: `${Math.round((t.correct / t.total) * 100)}% (${t.correct}/${t.total})`,
        date: t.date
      }));

      return {
        id: s.id,
        name: s.name,
        username: s.username,
        grade: s.grade || 'Grade 8',
        classId: s.class_id,
        results: {
          elaScore: null,
          mathScore: null,
          avgAccuracy,
          topicAccuracy,
          missedQuestions,
          tests
        }
      };
    });

    return { classes, students, questions };
  }

  async function updateInstructorName(newName) {
    const sb = getClient();
    if (!currentTeacherUser) return;
    const { error } = await sb
      .from('profiles')
      .update({ display_name: newName })
      .eq('id', currentTeacherUser.id);

    if (error) throw error;
    localStorage.setItem('prepify_instructor_name', newName);
  }

  async function createClass(name, schedule, joinCode) {
    const sb = getClient();
    const { data, error } = await sb
      .from('classes')
      .insert({
        teacher_id: currentTeacherUser.id,
        name,
        schedule,
        join_code: joinCode
      })
      .select()
      .single();

    if (error) throw error;
    return {
      id: data.id,
      name: data.name,
      schedule: data.schedule || '',
      joinCode: data.join_code
    };
  }

  async function createStudent({ name, username, classId, grade, passcode }) {
    const sb = getClient();
    const { data, error } = await sb
      .from('students')
      .insert({
        teacher_id: currentTeacherUser.id,
        class_id: classId || null,
        name,
        username: username.toLowerCase(),
        grade: grade || 'Grade 8',
        passcode: passcode.toUpperCase()
      })
      .select()
      .single();

    if (error) throw error;
    return {
      id: data.id,
      name: data.name,
      username: data.username,
      grade: data.grade,
      classId: data.class_id,
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
      .update({ passcode: newPasscode.toUpperCase() })
      .eq('id', studentId);

    if (error) throw error;
    return newPasscode.toUpperCase();
  }

  async function upsertQuestion(item) {
    const sb = getClient();
    const payload = {
      id: item.id,
      teacher_id: currentTeacherUser.id,
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

    const { error } = await sb.from('questions').upsert(payload);
    if (error) throw error;
    return item;
  }

  async function deleteQuestion(questionId) {
    const sb = getClient();
    const { error } = await sb.from('questions').delete().eq('id', questionId);
    if (error) throw error;
  }

  async function createTestAssignment({
    title,
    testType = 'topic_test',
    timeLimitMinutes = null,
    targetGrade = 'Both',
    assignTargetType = 'class',
    classId = null,
    studentIds = [],
    questionIds = [],
    adaptiveQuestionCount = 20
  }) {
    const sb = getClient();

    const storedQuestionIds = testType === 'full_adaptive_simulation'
      ? [`ADAPTIVE:${adaptiveQuestionCount || 20}:${targetGrade}`]
      : Array.from(questionIds);

    const fullPayload = {
      teacher_id: currentTeacherUser.id,
      class_id: assignTargetType === 'class' ? classId : null,
      title,
      test_type: testType,
      time_limit_minutes: timeLimitMinutes ? parseInt(timeLimitMinutes, 10) : null,
      target_grade: targetGrade,
      student_ids: assignTargetType === 'students' ? studentIds : [],
      question_ids: storedQuestionIds
    };

    let { data, error } = await sb.from('assignments').insert(fullPayload).select().single();

    if (error && error.message && error.message.includes('column')) {
      const fallbackPayload = {
        teacher_id: currentTeacherUser.id,
        class_id: classId,
        title,
        question_ids: storedQuestionIds
      };
      const retry = await sb.from('assignments').insert(fallbackPayload).select().single();
      data = retry.data;
      error = retry.error;
    }

    if (error) throw error;
    return data;
  }

  async function createAssignment(title, classId, questionIds) {
    return createTestAssignment({
      title,
      assignTargetType: 'class',
      classId,
      questionIds
    });
  }

  window.PrepifyTeacherDB = {
    initTeacherSession,
    loadTeacherWorkspace,
    updateInstructorName,
    createClass,
    createStudent,
    resetStudentPasscode,
    upsertQuestion,
    deleteQuestion,
    createAssignment,
    createTestAssignment
  };
})();