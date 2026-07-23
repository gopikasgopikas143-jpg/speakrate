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
const sidebarEl = document.querySelector('.sidebar');
const navToggleBtn = document.getElementById('nav-toggle-btn');
if (navToggleBtn) {
  navToggleBtn.onclick = () => sidebarEl.classList.toggle('nav-open');
}

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
    if (sidebarEl) sidebarEl.classList.remove('nav-open'); // close the mobile dropdown after picking a view
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
  const sessionMode = document.getElementById('session-mode-select').value;
  if (!name) return alert('Enter a room name.');

  const resp = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
    body: JSON.stringify({ name, password: password || undefined, topic: topic || undefined, teamMode, sessionMode }),
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

    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex; gap:8px; margin-top:10px;';

    const enterBtn = document.createElement('button');
    enterBtn.textContent = 'Enter Room';
    enterBtn.style.cssText = 'margin-bottom:0; flex:1;';
    enterBtn.onclick = () => window.location.href = `room.html?code=${r.code}`;

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = '🗑️ Delete';
    deleteBtn.style.cssText = 'margin-bottom:0; width:auto; flex:none; background:#442228; color:#ff8a8a;';
    deleteBtn.onclick = async () => {
      if (!confirm(`Delete "${r.name}" (${r.code})? This can't be undone.`)) return;
      deleteBtn.disabled = true;
      deleteBtn.textContent = 'Deleting...';
      const resp = await fetch(`/api/rooms/${r.code}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${accessToken}` },
      });
      const result = await resp.json();
      if (!resp.ok) {
        alert(result.error || 'Could not delete room.');
        deleteBtn.disabled = false;
        deleteBtn.textContent = '🗑️ Delete';
        return;
      }
      loadMyRooms();
    };

    btnRow.appendChild(enterBtn);
    btnRow.appendChild(deleteBtn);
    div.appendChild(btnRow);
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
      const typeLabels = { room: '👥 Room', solo: '🎤 Solo', conversation: '💬 AI' };
      const badgesHtml = (row.types || [])
        .map(t => `<span class="badge session-type-badge ${t}">${typeLabels[t] || t}</span>`)
        .join(' ');
      div.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px; flex-wrap:wrap;">
          <h3 style="margin:0;">#${row.rank} — ${escapeHtml(row.name)}</h3>
          <div style="display:flex; gap:4px; flex-wrap:wrap;">${badgesHtml}</div>
        </div>
        <div class="score-row" style="margin-top:6px;"><span>${row.sessionCount} session${row.sessionCount === 1 ? '' : 's'}</span><span><strong>${row.avgFinalScore}/10</strong></span></div>`;
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
    const typeLabels = { room: '👥 Room', solo: '🎤 Solo', conversation: '💬 Conversation' };
    const typeBit = `<span class="badge session-type-badge ${r.session_type}">${typeLabels[r.session_type] || r.session_type}</span>`;
    const topicBit = r.topic ? `<div class="hint" style="margin:4px 0 0;">Topic: ${escapeHtml(r.topic)}</div>` : '';

    div.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
        <h3 style="margin:0;">${escapeHtml(r.room_name || 'Practice Session')} <span style="opacity:.6;font-weight:400;font-size:12px;">${date}</span></h3>
        <button class="delete-history-btn" data-id="${r.id}" title="Delete this session" style="width:auto; flex:none; margin:0; padding:6px 10px; font-size:12px; background:#3a2a3a; color:#ff8a8a;">🗑️</button>
      </div>
      <div style="margin-bottom:6px;">${typeBit}</div>
      ${topicBit}
      <div class="score-row"><span>AI: ${r.ai_overall}/10</span><span>${peerBit}</span><span><strong>Final: ${r.final_score}/10</strong></span></div>
      <div class="score-row"><span>Filler words: ${r.filler_word_count ?? '—'}</span><span>${r.words_per_minute ?? '—'} wpm</span></div>
      <div style="margin-top:6px; display:flex; gap:6px;">${teamBit}${bestBit}</div>`;

    div.querySelector('.delete-history-btn').addEventListener('click', async () => {
      if (!confirm('Delete this session from your history? This cannot be undone.')) return;
      const btn = div.querySelector('.delete-history-btn');
      btn.disabled = true;
      try {
        const resp = await fetch(`/api/history/${r.id}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        const result = await resp.json();
        if (!resp.ok) throw new Error(result.error || 'Could not delete session.');
        div.remove();
        const remaining = data.filter(x => x.id !== r.id);
        renderHistoryChart(remaining);
        renderFairnessChart(remaining);
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
      }
    });

    if (r.audio_url) {
      if (r.session_type === 'conversation') {
        try {
          const urls = JSON.parse(r.audio_url);
          urls.forEach((u, i) => {
            const label = document.createElement('div');
            label.className = 'hint';
            label.style.marginTop = '8px';
            label.textContent = `Answer ${i + 1}:`;
            const audioEl = document.createElement('audio');
            audioEl.src = u; audioEl.controls = true;
            div.appendChild(label);
            div.appendChild(audioEl);
          });
        } catch (e) { /* malformed, skip playback */ }
      } else {
        const audioEl = document.createElement('audio');
        audioEl.src = r.audio_url; audioEl.controls = true;
        div.appendChild(audioEl);
      }
    }

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
  const icons = {
    '5-Day Streak': '🔥', 'Top Speaker of the Week': '🥇',
    'Filler Words Cut in Half': '✂️', 'Fluency Climb': '📈',
  };
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