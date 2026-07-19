const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

let currentUser = null;
let currentProfile = null;
let accessToken = null;

async function init() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { window.location.href = 'login.html'; return; }

  currentUser = session.user;
  accessToken = session.access_token;

  const { data: profile } = await sb.from('profiles').select('name, role').eq('id', currentUser.id).single();
  currentProfile = profile || { name: currentUser.email, role: 'student' };

  document.getElementById('user-info').innerHTML =
    `<strong>${escapeHtml(currentProfile.name)}</strong><br><span style="opacity:.7;font-size:12px;">${currentProfile.role}</span>`;

  if (currentProfile.role === 'admin') {
    document.getElementById('admin-nav-link').classList.remove('hidden');
  }

  loadMyRooms();
}
init();

document.getElementById('logout-btn').onclick = async () => {
  await sb.auth.signOut();
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
    if (link.dataset.view === 'join-room') loadBrowseRooms();
    if (link.dataset.view === 'create-room') loadMyRooms();
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
  loadMyRooms();
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

// ---------- My rooms (shown under Create Room) ----------
async function loadMyRooms() {
  const listEl = document.getElementById('my-rooms-list');
  listEl.innerHTML = '<p class="hint">Loading...</p>';
  const resp = await fetch('/api/rooms/mine', { headers: { 'Authorization': `Bearer ${accessToken}` } });
  const data = await resp.json();
  if (!resp.ok) { listEl.innerHTML = `<p class="hint">${escapeHtml(data.error || 'Error')}</p>`; return; }
  if (data.length === 0) { listEl.innerHTML = '<p class="hint">You haven\'t created any rooms yet.</p>'; return; }

  listEl.innerHTML = '';
  data.forEach(r => {
    const div = document.createElement('div');
    div.className = 'score-card';
    const statusBadge = r.isLive
      ? `<span class="badge" style="background:#00cec9;">🟢 live · ${r.memberCount} in room · ${r.state}</span>`
      : `<span class="badge" style="background:#636e72;">not started</span>`;
    div.innerHTML = `<h3>${escapeHtml(r.name)} — ${r.code}</h3>${statusBadge}`;
    const btn = document.createElement('button');
    btn.textContent = 'Enter Room';
    btn.style.marginTop = '10px';
    btn.onclick = () => window.location.href = `room.html?code=${r.code}`;
    div.appendChild(btn);
    listEl.appendChild(div);
  });
}

// ---------- Browse rooms (shown under Join Room) ----------
async function loadBrowseRooms() {
  const listEl = document.getElementById('browse-rooms-list');
  listEl.innerHTML = '<p class="hint">Loading...</p>';
  const resp = await fetch('/api/rooms/browse', { headers: { 'Authorization': `Bearer ${accessToken}` } });
  const data = await resp.json();
  if (!resp.ok) { listEl.innerHTML = `<p class="hint">${escapeHtml(data.error || 'Error')}</p>`; return; }
  if (data.length === 0) { listEl.innerHTML = '<p class="hint">No rooms are open to join right now. Create one, or enter a code below.</p>'; return; }

  listEl.innerHTML = '';
  data.forEach(r => {
    const div = document.createElement('div');
    div.className = 'score-card';
    div.innerHTML = `<h3>${escapeHtml(r.name)} — ${r.code}</h3>
      <div class="score-row"><span>${r.memberCount}/8 joined</span><span>${r.hasPassword ? '🔒 Password protected' : '🔓 Open'}</span></div>`;

    const joinBtn = document.createElement('button');
    joinBtn.textContent = 'Join';
    joinBtn.style.marginTop = '10px';

    if (r.hasPassword) {
      const pwInput = document.createElement('input');
      pwInput.type = 'password';
      pwInput.placeholder = 'Room password';
      pwInput.style.marginTop = '10px';
      div.appendChild(pwInput);
      joinBtn.onclick = () => {
        if (!pwInput.value) { pwInput.focus(); return; }
        window.location.href = `room.html?code=${r.code}&pw=${encodeURIComponent(pwInput.value)}`;
      };
    } else {
      joinBtn.onclick = () => window.location.href = `room.html?code=${r.code}`;
    }

    div.appendChild(joinBtn);
    listEl.appendChild(div);
  });
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}