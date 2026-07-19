const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

let isSignUpMode = false;

const nameField = document.getElementById('name-field');
const nameInput = document.getElementById('name-input');
const emailInput = document.getElementById('email-input');
const passwordInput = document.getElementById('password-input');
const submitBtn = document.getElementById('submit-btn');
const errorMsg = document.getElementById('error-msg');
const modeSubtitle = document.getElementById('mode-subtitle');
const toggleText = document.getElementById('toggle-text');
const toggleLink = document.getElementById('toggle-link');

// If already signed in, go straight to dashboard
sb.auth.getSession().then(({ data }) => {
  if (data.session) window.location.href = 'dashboard.html';
});

document.getElementById('google-btn').onclick = async () => {
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: window.location.origin + '/dashboard.html' },
  });
  if (error) {
    errorMsg.style.color = '#ff6b6b';
    errorMsg.textContent = error.message;
  }
};

toggleLink.onclick = (e) => {
  e.preventDefault();
  isSignUpMode = !isSignUpMode;
  nameField.classList.toggle('hidden', !isSignUpMode);
  submitBtn.textContent = isSignUpMode ? 'Sign Up' : 'Sign In';
  modeSubtitle.textContent = isSignUpMode ? 'Create your account' : 'Sign in to your account';
  toggleText.textContent = isSignUpMode ? 'Already have an account?' : "Don't have an account?";
  toggleLink.textContent = isSignUpMode ? 'Sign in' : 'Sign up';
  errorMsg.textContent = '';
};

submitBtn.onclick = async () => {
  errorMsg.textContent = '';
  const email = emailInput.value.trim();
  const password = passwordInput.value;

  if (!email || !password) {
    errorMsg.textContent = 'Enter both email and password.';
    return;
  }

  submitBtn.disabled = true;
  submitBtn.textContent = 'Please wait...';

  try {
    if (isSignUpMode) {
      const name = nameInput.value.trim();
      if (!name) { errorMsg.textContent = 'Enter your name.'; submitBtn.disabled = false; submitBtn.textContent = 'Sign Up'; return; }
      const { error } = await sb.auth.signUp({
        email, password,
        options: { data: { name } },
      });
      if (error) throw error;
      errorMsg.style.color = '#00cec9';
      errorMsg.textContent = 'Account created! Check your email if confirmation is required, or just sign in below.';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Sign Up';
      return;
    } else {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      window.location.href = 'dashboard.html';
    }
  } catch (err) {
    errorMsg.style.color = '#ff6b6b';
    errorMsg.textContent = err.message || 'Something went wrong.';
    submitBtn.disabled = false;
    submitBtn.textContent = isSignUpMode ? 'Sign Up' : 'Sign In';
  }
};