const supabase = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

let currentUser = null;
let currentProfile = null;
let accessToken = null;

async function init() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) { window.location.href = 'login.html'; return; }

  currentUser = session.user;
  accessToken = session.access_token;

  const { data: profile } = await supabase.from('profiles').select('name, role').eq('id', currentUser.id).single();
  currentProfile = profile || { name: currentUser.email, role: 'student' };

  document.getElementById('user-info').innerHTML =
    `<strong>${escapeHtml(currentProfile.name)}</strong><br><span style="opacity:.7;font-size:12px;">${currentProfile.role}</span>`;

  if (currentProfile.role === 'admin') {
    document.getElementById('admin-nav-link').classList.remove('hidden');
  }
}
init();

document.getElementById('logout-btn').onclick = async () => {
  await supabase.auth.signOut();
  window.location.href = 'login.html';
};

// ---------- Nav ----------
document.querySelectorAll('.nav-link').forEach(link => {
  link.onclick = (e) => {
    e.preventDefault();
    document.querySelectorAll('.nav-link').forEach(l => l.classList.remove('active'));
    link.classList.add('active');
    document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
    document.getElementById('view-' + link.dataset.view).classList.remove('hidden');
    if (link.dataset.view === 'admin-rooms') loadActiveRooms();
  };
});

// ---------- Create room ----------
document.getElementById('create-room-btn').onclick = async () => {
  const name = document.getElementById('room-name-input').value.trim();
  const password = document.getElementById('room-password-input').value;
  if (!name) return alert('Enter a room name.');

  const resp = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
    body: JSON.stringify({ name, password: password || undefined }),
  });
  const data = await resp.json();
  if (!resp.ok) return alert(data.error || 'Could not create room.');

  document.getElementById('created-room-code').textContent = data.roomCode;
  document.getElementById('create-room-result').classList.remove('hidden');
  document.getElementById('enter-created-room-btn').onclick = () => {
    window.location.href = `room.html?code=${data.roomCode}`;
  };
};

// ---------- Join room ----------
document.getElementById('join-room-btn').onclick = () => {
  const code = document.getElementById('join-code-input').value.trim().toUpperCase();
  const password = document.getElementById('join-password-input').value;
  if (!code) return (document.getElementById('join-error').textContent = 'Enter a room code.');
  const url = `room.html?code=${encodeURIComponent(code)}` + (password ? `&pw=${encodeURIComponent(password)}` : '');
  window.location.href = url;
};

// ---------- Admin: active rooms ----------
async function loadActiveRooms() {
  const listEl = document.getElementById('active-rooms-list');
  listEl.innerHTML = '<p class="hint">Loading...</p>';
  const resp = await fetch('/api/rooms/active', { headers: { 'Authorization': `Bearer ${accessToken}` } });
  const data = await resp.json();
  if (!resp.ok) { listEl.innerHTML = `<p class="hint">${escapeHtml(data.error || 'Error')}</p>`; return; }
  if (data.length === 0) { listEl.innerHTML = '<p class="hint">No active rooms right now.</p>'; return; }

  listEl.innerHTML = '';
  data.forEach(r => {
    const div = document.createElement('div');
    div.className = 'score-card';
    div.innerHTML = `<h3>${escapeHtml(r.name)} (${r.code})</h3>
      <div class="score-row"><span>${r.memberCount} members</span><span>${r.state}</span></div>`;
    const btn = document.createElement('button');
    btn.textContent = 'Watch (Observer)';
    btn.onclick = () => window.location.href = `room.html?code=${r.code}&observer=1`;
    div.appendChild(btn);
    listEl.appendChild(div);
  });
}
document.getElementById('refresh-rooms-btn').onclick = loadActiveRooms;

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}