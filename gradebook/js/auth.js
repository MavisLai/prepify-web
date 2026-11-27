// gradebook/auth.js

const STUDENT_SESSION_KEY = 'prepify_student_session';

/**
 * 1. TEACHER SIGN UP (Email + Password)
 */
async function signUpTeacher(email, password, displayName) {
  const { data, error } = await window.supabaseClient.auth.signUp({
    email: email.trim(),
    password,
    options: {
      data: {
        display_name: displayName.trim(),
        role: 'teacher'
      }
    }
  });

  if (error) throw error;

  if (data.user) {
    await window.supabaseClient.from('profiles').upsert({
      id: data.user.id,
      email: email.trim(),
      display_name: displayName.trim(),
      role: 'teacher'
    });
    localStorage.setItem('prepify_instructor_name', displayName.trim());
  }

  return data;
}

/**
 * 2. TEACHER LOGIN (Email + Password)
 */
async function loginTeacher(email, password) {
  // Clear any leftover student session
  localStorage.removeItem(STUDENT_SESSION_KEY);

  const { data, error } = await window.supabaseClient.auth.signInWithPassword({
    email: email.trim(),
    password
  });

  if (error) throw error;

  // Fetch instructor display name if stored in profiles
  if (data.user) {
    const { data: profile } = await window.supabaseClient
      .from('profiles')
      .select('display_name')
      .eq('id', data.user.id)
      .single();

    if (profile?.display_name) {
      localStorage.setItem('prepify_instructor_name', profile.display_name);
    }
  }

  window.location.href = 'teacher.html';
  return data;
}

/**
 * 3. STUDENT LOGIN (Username + One-Time / Assigned Passcode)
 * No email address needed for students.
 */
async function loginStudentWithPasscode(username, passcode) {
  const cleanUser = username.trim().toLowerCase();
  const cleanCode = passcode.trim().toUpperCase();

  const { data: student, error } = await window.supabaseClient
    .from('students')
    .select('id, name, username, grade, class_id, passcode')
    .eq('username', cleanUser)
    .single();

  if (error || !student) {
    throw new Error('Student username not found.');
  }

  if ((student.passcode || '').toUpperCase() !== cleanCode) {
    throw new Error('Incorrect passcode. Ask your instructor to check or reset it.');
  }

  const sessionPayload = {
    id: student.id,
    name: student.name,
    username: student.username,
    grade: student.grade || 'Grade 8',
    classId: student.class_id,
    loggedInAt: Date.now()
  };

  localStorage.setItem(STUDENT_SESSION_KEY, JSON.stringify(sessionPayload));
  window.location.href = 'student.html';
  return sessionPayload;
}

/**
 * 4. SESSION HELPERS & ROUTE GUARDS
 */
async function getCurrentTeacher() {
  const { data: { session } } = await window.supabaseClient.auth.getSession();
  return session?.user || null;
}

function getCurrentStudent() {
  try {
    const raw = localStorage.getItem(STUDENT_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function requireTeacher() {
  const teacher = await getCurrentTeacher();
  if (!teacher) {
    window.location.href = 'login.html';
    return null;
  }
  return teacher;
}

function requireStudent() {
  const student = getCurrentStudent();
  if (!student) {
    window.location.href = 'login.html';
    return null;
  }
  return student;
}

/**
 * 5. LOG OUT (Works for both Teachers and Students)
 */
async function logoutUser() {
  localStorage.removeItem(STUDENT_SESSION_KEY);
  await window.supabaseClient.auth.signOut();
  window.location.href = 'login.html';
}

// Expose functions globally for inline scripts & forms
window.PrepifyAuth = {
  signUpTeacher,
  loginTeacher,
  loginStudentWithPasscode,
  getCurrentTeacher,
  getCurrentStudent,
  requireTeacher,
  requireStudent,
  logoutUser
};