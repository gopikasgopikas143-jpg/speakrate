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
  loadMyBadges();
  populateTopicSelect();
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
    if (link.dataset.view === 'leaderboard') loadLeaderboard(currentLbTab, currentLbPeriod);
    if (link.dataset.view === 'history') loadHistory();
  };
});

// ---------- Create room ----------
function populateTopicSelect() {
  const select = document.getElementById('topic-select');
  if (!window.TOPIC_BANK) return;
  Object.entries(window.TOPIC_BANK).forEach(([category, topics]) => {
    const group = document.createElement('optgroup');
    group.label = category;
    topics.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      group.appendChild(opt);
    });
    select.appendChild(group);
  });
}

document.getElementById('topic-select').onchange = (e) => {
  if (e.target.value) document.getElementById('topic-input').value = e.target.value;
};

document.getElementById('random-topic-btn').onclick = () => {
  if (!window.TOPIC_BANK) return;
  const allTopics = Object.values(window.TOPIC_BANK).flat();
  const pick = allTopics[Math.floor(Math.random() * allTopics.length)];
  document.getElementById('topic-input').value = pick;
  document.getElementById('topic-select').value = '';
};

document.getElementById('create-room-btn').onclick = async () => {
  const name = document.getElementById('room-name-input').value.trim();
  const password = document.getElementById('room-password-input').value;
  const topic = document.getElementById('topic-input').value.trim();
  const teamMode = document.getElementById('team-mode-checkbox').checked;
  if (!name) return alert('Enter a room name.');

  const resp = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
    body: JSON.stringify({ name, password: password || undefined, topic: topic || undefined, teamMode }),
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

// ---------- Leaderboard ----------
let currentLbTab = 'players';
let currentLbPeriod = 'week';
let historyChart = null;
let fairnessChart = null;

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentLbTab = btn.dataset.lbTab;
    if (btn.dataset.lbPeriod) currentLbPeriod = btn.dataset.lbPeriod;
    loadLeaderboard(currentLbTab, currentLbPeriod);
  };
});

async function loadLeaderboard(tab, period) {
  const listEl = document.getElementById('leaderboard-list');
  listEl.innerHTML = '<p class="hint">Loading...</p>';

  const url = tab === 'teams' ? '/api/leaderboard/teams' : `/api/leaderboard?period=${period}`;
  const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${accessToken}` } });
  const data = await resp.json();
  if (!resp.ok) { listEl.innerHTML = `<p class="hint">${escapeHtml(data.error || 'Error')}</p>`; return; }
  if (data.length === 0) { listEl.innerHTML = '<p class="hint">No sessions to rank yet.</p>'; return; }

  listEl.innerHTML = '';
  data.forEach(row => {
    const div = document.createElement('div');
    div.className = 'score-card';
    if (tab === 'teams') {
      div.innerHTML = `
        <h3>#${row.rank} — Team ${escapeHtml(row.team)} <span style="opacity:.7;font-weight:400;font-size:13px;">(${escapeHtml(row.roomName)} · ${row.roomCode})</span></h3>
        <div class="score-row"><span>${row.memberCount} member${row.memberCount === 1 ? '' : 's'}</span><span><strong>${row.avgScore}/10</strong></span></div>`;
    } else {
      div.innerHTML = `
        <h3>#${row.rank} — ${escapeHtml(row.name)}</h3>
        <div class="score-row"><span>${row.sessionCount} session${row.sessionCount === 1 ? '' : 's'}</span><span><strong>${row.avgFinalScore}/10</strong></span></div>`;
    }
    listEl.appendChild(div);
  });
}

// ---------- My History ----------
async function loadHistory() {
  const listEl = document.getElementById('history-list');
  listEl.innerHTML = '<p class="hint">Loading...</p>';

  const resp = await fetch('/api/history/mine', { headers: { 'Authorization': `Bearer ${accessToken}` } });
  const data = await resp.json();
  if (!resp.ok) { listEl.innerHTML = `<p class="hint">${escapeHtml(data.error || 'Error')}</p>`; return; }
  if (data.length === 0) {
    listEl.innerHTML = '<p class="hint">No completed sessions yet — finish a room to see your history here.</p>';
    renderHistoryChart([]);
    renderFairnessChart([]);
    return;
  }

  listEl.innerHTML = '';
  data.forEach(r => {
    const div = document.createElement('div');
    div.className = 'score-card';
    const date = new Date(r.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const peerBit = r.peer_average != null ? `Peer: ${r.peer_average}/10` : 'Peer: —';
    const teamBit = r.team ? `<span class="badge" style="background:#636e72;">Team ${escapeHtml(r.team)}</span>` : '';
    const bestBit = r.is_best_speaker ? `<span class="badge" style="background:#f6b93b;color:#2b1a00;">🏆 Best Speaker</span>` : '';
    div.innerHTML = `
      <h3>${escapeHtml(r.room_name || r.room_code)} <span style="opacity:.6;font-weight:400;font-size:12px;">${date}</span></h3>
      <div class="score-row"><span>AI: ${r.ai_overall}/10</span><span>${peerBit}</span><span><strong>Final: ${r.final_score}/10</strong></span></div>
      <div class="score-row"><span>Filler words: ${r.filler_word_count ?? '—'}</span><span>${r.words_per_minute ?? '—'} wpm</span></div>
      <div style="margin-top:6px; display:flex; gap:6px;">${teamBit}${bestBit}</div>`;
    listEl.appendChild(div);
  });

  renderHistoryChart(data);
  renderFairnessChart(data);
}

function renderHistoryChart(rows) {
  const canvas = document.getElementById('history-chart');
  if (!canvas || !window.Chart) return;
  const chronological = [...rows].reverse(); // oldest -> newest
  const labels = chronological.map(r => new Date(r.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));

  if (historyChart) historyChart.destroy();
  historyChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Final Score', data: chronological.map(r => r.final_score), borderColor: '#6c5ce7', backgroundColor: 'transparent', tension: 0.3 },
        { label: 'Clarity', data: chronological.map(r => r.clarity), borderColor: '#00cec9', backgroundColor: 'transparent', tension: 0.3 },
        { label: 'Fluency', data: chronological.map(r => r.fluency), borderColor: '#f6b93b', backgroundColor: 'transparent', tension: 0.3 },
      ],
    },
    options: {
      responsive: true,
      scales: {
        y: { min: 0, max: 10, ticks: { color: '#a0a0c0' }, grid: { color: '#2a2a45' } },
        x: { ticks: { color: '#a0a0c0' }, grid: { color: '#2a2a45' } },
      },
      plugins: { legend: { labels: { color: '#f0f0f5' } } },
    },
  });
}

function renderFairnessChart(rows) {
  const canvas = document.getElementById('fairness-chart');
  if (!canvas || !window.Chart) return;
  const withPeer = rows.filter(r => r.peer_average != null);

  const avg = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const avgAi = +avg(withPeer.map(r => r.ai_overall)).toFixed(2);
  const avgPeer = +avg(withPeer.map(r => r.peer_average)).toFixed(2);

  if (fairnessChart) fairnessChart.destroy();
  fairnessChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: ['Your Averages'],
      datasets: [
        { label: 'AI Overall', data: [avgAi], backgroundColor: '#6c5ce7' },
        { label: 'Peer Average', data: [avgPeer], backgroundColor: '#00cec9' },
      ],
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      scales: {
        x: { min: 0, max: 10, ticks: { color: '#a0a0c0' }, grid: { color: '#2a2a45' } },
        y: { ticks: { color: '#a0a0c0' }, grid: { color: '#2a2a45' } },
      },
      plugins: { legend: { labels: { color: '#f0f0f5' } } },
    },
  });
}

// ---------- Badges ----------
async function loadMyBadges() {
  const el = document.getElementById('badges-list');
  const resp = await fetch('/api/badges/mine', { headers: { 'Authorization': `Bearer ${accessToken}` } });
  const data = await resp.json();
  if (!resp.ok || !data.length) { el.innerHTML = ''; return; }

  const seen = new Set();
  const icons = { '5-Day Streak': '🔥', 'Top Speaker of the Week': '🥇' };
  el.innerHTML = data
    .filter(b => !seen.has(b.badge_type) && seen.add(b.badge_type))
    .map(b => `<span class="badge" style="background:#2a2a45;margin:2px 4px 2px 0;">${icons[b.badge_type] || '🏅'} ${escapeHtml(b.badge_type)}</span>`)
    .join('');
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}