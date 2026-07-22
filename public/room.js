const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
const socket = io();

const params = new URLSearchParams(window.location.search);
const roomCode = params.get('code');
const isObserverRequest = params.get('observer') === '1';
const prefilledPassword = params.get('pw') || '';

let myId = null;
let myName = '';
let accessToken = null;
let isObserver = false;
let isHost = false;
let latestSummary = null;
let sessionMode = 'fixed-turn';
let isMySpeakingTurn = false;   // fixed-turn mode
let holdingFloor = false;       // GD mode
let micMuted = false;           // fixed-turn manual mute state

// ---------- LiveKit ----------
let lkRoom = null;
let livekitInitialized = false;
const audioEls = {}; // keyed by LiveKit participant identity (== user id)

let mediaRecorder = null;
let recordedChunks = [];

// ---------- DOM ----------
const roomScreen = document.getElementById('room-screen');
const peerRatingScreen = document.getElementById('peer-rating-screen');
const resultsScreen = document.getElementById('results-screen');
const roomTitle = document.getElementById('room-title');
const roomStateBadge = document.getElementById('room-state');
const observerBanner = document.getElementById('observer-banner');
const topicBanner = document.getElementById('topic-banner');
const topicText = document.getElementById('topic-text');
const teamPanel = document.getElementById('team-panel');
const teamAssignmentList = document.getElementById('team-assignment-list');
const randomizeTeamsBtn = document.getElementById('randomize-teams-btn');
const teamResultsEl = document.getElementById('team-results');
const membersGrid = document.getElementById('members-grid');
const turnBanner = document.getElementById('turn-banner');
const turnText = document.getElementById('turn-text');
const turnTimerEl = document.getElementById('turn-timer');
const gdStartPanel = document.getElementById('gd-start-panel');
const gdDurationInput = document.getElementById('gd-duration-input');
const startGdBtn = document.getElementById('start-gd-btn');
const gdBanner = document.getElementById('gd-banner');
const gdStatusText = document.getElementById('gd-status-text');
const gdTimerEl = document.getElementById('gd-timer');
const micBtn = document.getElementById('mic-btn');
const startBtn = document.getElementById('start-btn');
const skipBtn = document.getElementById('skip-btn');
const statusLine = document.getElementById('status-line');
const bestSpeakerEl = document.getElementById('best-speaker');
const gdParticipationBanner = document.getElementById('gd-participation-banner');
const scoresListEl = document.getElementById('scores-list');
const peerRatingList = document.getElementById('peer-rating-list');
const submitRatingsBtn = document.getElementById('submit-ratings-btn');
const peerRatingProgress = document.getElementById('peer-rating-progress');

let turnCountdown = null;
let gdCountdown = null;
let myPeerRatings = {};

// ---------- Init: auth + join ----------
(async function initRoom() {
  if (!roomCode) { alert('No room code provided.'); window.location.href = 'dashboard.html'; return; }

  const { data: { session } } = await sb.auth.getSession();
  if (!session) { window.location.href = 'login.html'; return; }
  accessToken = session.access_token;

  const { data: profile } = await sb.from('profiles').select('name, role').eq('id', session.user.id).single();
  myName = profile?.name || session.user.email;

  roomTitle.textContent = `Room: ${roomCode}`;
  isObserver = isObserverRequest && profile?.role === 'admin';

  if (isObserver) {
    observerBanner.classList.remove('hidden');
    document.getElementById('controls').classList.add('hidden');
  }

  socket.emit('join-room', { roomCode, password: prefilledPassword, token: accessToken, observerMode: isObserver });
})();

socket.on('connect', () => { myId = socket.id; });

socket.on('join-error', (msg) => {
  alert(msg);
  window.location.href = 'dashboard.html';
});

socket.on('observer-joined', (summary) => {
  latestSummary = summary;
  sessionMode = summary.sessionMode || 'fixed-turn';
  renderMembers(summary);
  ensureLiveKitConnected();
});

socket.on('joined-info', ({ isHost: hostFlag }) => {
  isHost = hostFlag;
  if (latestSummary) renderTeamPanel(latestSummary);
});

// These used to drive manual WebRTC peer-connection setup; LiveKit now
// handles all audio peering internally, so there's nothing to do here
// beyond letting room-update (below) keep the members grid in sync.
socket.on('existing-peers', () => {});
socket.on('observer-joined-peer', () => {});
socket.on('peer-joined', () => {});
socket.on('peer-left', () => {});

// ---------- LiveKit audio ----------
// Connects to LiveKit once we know our observer/session-mode status (learned
// from the first room summary), fetches a token from our own server, and
// wires up remote-audio playback. Room *metadata* (topic, turn order, team,
// GD floor state) stays on Socket.IO's 'room-update' — this only handles audio.
async function ensureLiveKitConnected() {
  if (livekitInitialized) return;
  livekitInitialized = true;

  try {
    const resp = await fetch('/api/livekit/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ roomCode, observerMode: isObserver, password: prefilledPassword }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      statusLine.textContent = data.error || 'Could not connect audio.';
      return;
    }

    const { Room, RoomEvent } = window.LivekitClient;
    lkRoom = new Room({
      audioCaptureDefaults: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      // LiveKit's client SDK auto-reconnects on network changes — no manual
      // ICE-state handling needed, unlike raw WebRTC.
    });

    lkRoom.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (track.kind !== 'audio') return;
      let audioEl = audioEls[participant.identity];
      if (!audioEl) {
        audioEl = document.createElement('audio');
        audioEl.autoplay = true;
        document.body.appendChild(audioEl);
        audioEls[participant.identity] = audioEl;
      }
      track.attach(audioEl);
    });

    lkRoom.on(RoomEvent.TrackUnsubscribed, (track) => {
      track.detach();
    });

    await lkRoom.connect(data.url, data.token);

    if (!isObserver) {
      if (sessionMode === 'gd') {
        // GD mode: mic stays off (not published) until the floor is
        // granted via 'mic-granted' — this is what actually prevents
        // audio overlap, not just the app-level bookkeeping.
      } else {
        await lkRoom.localParticipant.setMicrophoneEnabled(true);
      }
    }
  } catch (e) {
    console.error('LiveKit connect failed:', e);
    if (!isObserver) {
      alert('Microphone access is required to join a room.');
      window.location.href = 'dashboard.html';
    } else {
      statusLine.textContent = 'Could not connect audio (LiveKit).';
    }
  }
}

function getLocalAudioMediaStream() {
  if (!lkRoom || !lkRoom.localParticipant) return null;
  const pubs = [...lkRoom.localParticipant.audioTrackPublications.values()];
  const track = pubs[0]?.track;
  if (!track || !track.mediaStreamTrack) return null;
  return new MediaStream([track.mediaStreamTrack]);
}

// ---------- Room state ----------
socket.on('room-update', (summary) => {
  latestSummary = summary;
  sessionMode = summary.sessionMode || 'fixed-turn';
  roomStateBadge.textContent = summary.state;
  renderMembers(summary);
  renderTeamPanel(summary);
  ensureLiveKitConnected();

  if (summary.topic) {
    topicText.textContent = summary.topic;
    topicBanner.classList.remove('hidden');
  }

  if (!isObserver) {
    const showGdStartPanel = isHost && sessionMode === 'gd' && summary.state === 'waiting';
    gdStartPanel.classList.toggle('hidden', !showGdStartPanel);

    startBtn.classList.toggle('hidden', sessionMode === 'gd' || summary.state !== 'waiting');
    startBtn.disabled = summary.members.length < 2;

    if (summary.state === 'waiting') {
      statusLine.textContent = `${summary.members.length}/8 joined. Need at least 2 to start.`;
    } else if (summary.state !== 'gd-discussion') {
      statusLine.textContent = '';
    }

    // Reflect current GD floor holder on every update, in case we missed
    // the original mic-granted/mic-released broadcast (e.g. reconnect).
    if (sessionMode === 'gd' && summary.state === 'gd-discussion') {
      updateGdMicButton(summary.activeSpeakerId, summary.activeSpeakerName);
    }
  }
});

function renderMembers(summary) {
  membersGrid.innerHTML = '';
  summary.members.forEach(m => {
    const teamClass = m.team === 'A' ? ' team-a' : m.team === 'B' ? ' team-b' : '';
    const isSpeaking = m.id === summary.currentSpeaker || m.id === summary.activeSpeakerId;
    const div = document.createElement('div');
    div.className = 'member-card' + (isSpeaking ? ' speaking' : '') + teamClass;
    const teamTag = m.team ? ` · Team ${m.team}` : '';
    div.innerHTML = `<div class="avatar">${isSpeaking ? '🗣️' : '🙂'}</div>
                      <div class="mname">${escapeHtml(m.name)}${m.id === myId ? ' (you)' : ''}${teamTag}</div>`;
    membersGrid.appendChild(div);
  });
}

// ---------- Team Mode (host only, while waiting) ----------
function renderTeamPanel(summary) {
  const shouldShow = isHost && summary.teamMode && summary.state === 'waiting' && !isObserver;
  teamPanel.classList.toggle('hidden', !shouldShow);
  if (!shouldShow) return;

  teamAssignmentList.innerHTML = '';
  summary.members.forEach(m => {
    const row = document.createElement('div');
    row.className = 'team-row';
    row.innerHTML = `<span>${escapeHtml(m.name)}${m.id === myId ? ' (you)' : ''}</span>`;
    const toggle = document.createElement('div');
    toggle.className = 'team-toggle';

    const btnA = document.createElement('button');
    btnA.textContent = 'Team A';
    btnA.type = 'button';
    btnA.className = m.team === 'A' ? 'selected-a' : '';
    btnA.onclick = () => socket.emit('assign-team', { targetId: m.id, team: m.team === 'A' ? null : 'A' });

    const btnB = document.createElement('button');
    btnB.textContent = 'Team B';
    btnB.type = 'button';
    btnB.className = m.team === 'B' ? 'selected-b' : '';
    btnB.onclick = () => socket.emit('assign-team', { targetId: m.id, team: m.team === 'B' ? null : 'B' });

    toggle.appendChild(btnA);
    toggle.appendChild(btnB);
    row.appendChild(toggle);
    teamAssignmentList.appendChild(row);
  });
}

randomizeTeamsBtn.onclick = () => socket.emit('randomize-teams');

startBtn.onclick = () => socket.emit('start-session');
skipBtn.onclick = () => socket.emit('skip-turn');

startGdBtn.onclick = () => {
  const durationMinutes = Math.max(1, Number(gdDurationInput.value) || 5);
  socket.emit('start-gd-session', { durationMinutes });
};

// ---------- Mic button: fixed-turn mute/unmute vs GD request/release floor ----------
micBtn.onclick = () => {
  if (isObserver) return;

  if (sessionMode === 'gd') {
    if (holdingFloor) socket.emit('release-mic');
    else socket.emit('request-mic');
    return;
  }

  micMuted = !micMuted;
  lkRoom?.localParticipant?.setMicrophoneEnabled(!micMuted);
  micBtn.textContent = micMuted ? '🔇 Unmute' : '🎤 Mute';
};

function updateGdMicButton(activeSpeakerId, activeSpeakerName) {
  if (isObserver) return;
  if (!activeSpeakerId) {
    holdingFloor = false;
    micBtn.disabled = false;
    micBtn.textContent = '🎤 Tap to speak';
  } else if (activeSpeakerId === myId) {
    holdingFloor = true;
    micBtn.disabled = false;
    micBtn.textContent = '🔴 Release Mic (you are speaking)';
  } else {
    holdingFloor = false;
    micBtn.disabled = true;
    micBtn.textContent = `🔇 ${activeSpeakerName || 'Someone'} is speaking...`;
  }
}

// ---------- GD Mode events ----------
socket.on('gd-session-start', ({ seconds }) => {
  roomScreen.classList.remove('hidden');
  peerRatingScreen.classList.add('hidden');
  resultsScreen.classList.add('hidden');
  gdStartPanel.classList.add('hidden');
  startBtn.classList.add('hidden');
  gdBanner.classList.remove('hidden');
  gdStatusText.textContent = 'Group discussion in progress...';
  micBtn.classList.remove('hidden');
  micBtn.disabled = false;
  micBtn.textContent = '🎤 Tap to speak';
  statusLine.textContent = '';

  let remaining = seconds;
  updateGdTimerDisplay(remaining);
  clearInterval(gdCountdown);
  gdCountdown = setInterval(() => {
    remaining -= 1;
    updateGdTimerDisplay(Math.max(remaining, 0));
    if (remaining <= 0) clearInterval(gdCountdown);
  }, 1000);
});

function updateGdTimerDisplay(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  gdTimerEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
}

socket.on('mic-granted', ({ id, name }) => {
  updateGdMicButton(id, name);
  if (id === myId) {
    lkRoom?.localParticipant?.setMicrophoneEnabled(true).then(() => startRecording());
  }
});

socket.on('mic-released', ({ id }) => {
  if (id === myId) {
    stopRecording();
    lkRoom?.localParticipant?.setMicrophoneEnabled(false);
    statusLine.textContent = 'Uploading your recording...';
  }
  updateGdMicButton(null, null);
});

socket.on('mic-denied', ({ holderName }) => {
  statusLine.textContent = `${holderName} currently has the floor — try again once they release it.`;
});

socket.on('force-release-mic', () => {
  stopRecording();
  lkRoom?.localParticipant?.setMicrophoneEnabled(false);
});

socket.on('gd-session-end', () => {
  clearInterval(gdCountdown);
  gdBanner.classList.add('hidden');
  micBtn.classList.add('hidden');
  statusLine.textContent = 'Discussion ended — scoring participation...';
});

// ---------- Turn / recording (fixed-turn mode) ----------
socket.on('turn-start', ({ speakerId, speakerName, seconds }) => {
  turnBanner.classList.remove('hidden');
  turnText.textContent = `${speakerName} is speaking...`;
  isMySpeakingTurn = speakerId === myId;
  skipBtn.classList.toggle('hidden', !isMySpeakingTurn);

  let remaining = seconds;
  turnTimerEl.textContent = remaining;
  clearInterval(turnCountdown);
  turnCountdown = setInterval(() => {
    remaining -= 1;
    turnTimerEl.textContent = Math.max(remaining, 0);
    if (remaining <= 0) clearInterval(turnCountdown);
  }, 1000);

  if (isMySpeakingTurn) startRecording();
});

socket.on('turn-end', () => {
  if (isMySpeakingTurn) {
    stopRecording();
    isMySpeakingTurn = false;
    skipBtn.classList.add('hidden');
    statusLine.textContent = 'Uploading your recording...';
  }
});

socket.on('transcribing-status', ({ name }) => {
  statusLine.textContent = `Transcribing ${name}'s speech...`;
});

function startRecording() {
  const stream = getLocalAudioMediaStream();
  if (!stream) { statusLine.textContent = 'Microphone not ready yet — try again in a moment.'; return; }

  recordedChunks = [];
  let options = { mimeType: 'audio/webm;codecs=opus' };
  if (!MediaRecorder.isTypeSupported(options.mimeType)) options = {};
  try { mediaRecorder = new MediaRecorder(stream, options); }
  catch (e) { statusLine.textContent = 'Recording not supported in this browser.'; return; }

  mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) recordedChunks.push(e.data); };
  mediaRecorder.onstop = async () => {
    const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
    const buffer = await blob.arrayBuffer();
    socket.emit('audio-recording', buffer);
  };
  mediaRecorder.start();
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try { mediaRecorder.stop(); } catch (e) {}
  }
}

// ---------- Peer rating (fixed-turn mode) ----------
socket.on('peer-rating-start', ({ members, seconds }) => {
  roomScreen.classList.add('hidden');
  peerRatingScreen.classList.remove('hidden');
  myPeerRatings = {};

  peerRatingList.innerHTML = '';
  members.filter(m => m.id !== myId).forEach(m => {
    const row = document.createElement('div');
    row.className = 'score-card';
    row.innerHTML = `<h3>${escapeHtml(m.name)}</h3><div class="stars" data-target="${m.id}"></div>`;
    const starsDiv = row.querySelector('.stars');
    for (let i = 1; i <= 5; i++) {
      const star = document.createElement('span');
      star.textContent = '☆';
      star.style.cursor = 'pointer';
      star.style.fontSize = '24px';
      star.dataset.value = i;
      star.onclick = () => {
        myPeerRatings[m.id] = i;
        [...starsDiv.children].forEach((s, idx) => { s.textContent = idx < i ? '★' : '☆'; });
      };
      starsDiv.appendChild(star);
    }
    peerRatingList.appendChild(row);
  });

  if (members.filter(m => m.id !== myId).length === 0) {
    peerRatingList.innerHTML = '<p class="hint">No one else to rate.</p>';
  }
});

socket.on('peer-rating-progress', ({ submitted, total }) => {
  peerRatingProgress.textContent = `${submitted}/${total} people have submitted ratings.`;
});

submitRatingsBtn.onclick = () => {
  socket.emit('submit-peer-ratings', { ratings: myPeerRatings });
  submitRatingsBtn.disabled = true;
  submitRatingsBtn.textContent = 'Waiting for others...';
};

// ---------- Results (fixed-turn AI rating) ----------
socket.on('rating-result', (result) => {
  stopRecording();
  peerRatingScreen.classList.add('hidden');
  roomScreen.classList.add('hidden');
  resultsScreen.classList.remove('hidden');
  gdParticipationBanner.classList.add('hidden');

  const best = result.scores.find(s => s.id === result.bestSpeakerId) || result.scores[0];
  bestSpeakerEl.innerHTML = `🏆 Best Speaker: <strong>${escapeHtml(best?.name || '?')}</strong><br>
    <span style="font-weight:400;font-size:14px;">${escapeHtml(result.bestSpeakerReason || '')}</span>`;

  if (result.teamMode && result.teamResults) {
    teamResultsEl.classList.remove('hidden');
    const winner = result.teamResults.A != null && result.teamResults.B != null
      ? (result.teamResults.A > result.teamResults.B ? 'A' : result.teamResults.B > result.teamResults.A ? 'B' : null)
      : null;
    teamResultsEl.innerHTML = ['A', 'B'].map(t => `
      <div class="score-card">
        <h3>Team ${t}${winner === t ? ' 🏆' : ''}</h3>
        <div class="score-row"><span>Avg Final Score</span><span><strong>${result.teamResults[t] ?? '—'}/10</strong></span></div>
      </div>`).join('');
  } else {
    teamResultsEl.classList.add('hidden');
  }

  scoresListEl.innerHTML = '';
  result.scores
    .sort((a, b) => (b.finalScore ?? b.overall) - (a.finalScore ?? a.overall))
    .forEach(s => {
      const div = document.createElement('div');
      div.className = 'score-card';
      const peerLine = s.peerAverage !== null && s.peerAverage !== undefined
        ? `<div class="score-row"><span>AI: ${s.overall}/10</span><span>Peer: ${s.peerAverage}/10</span><span><strong>Final: ${s.finalScore}/10</strong></span></div>`
        : `<div class="score-row"><span>AI: ${s.overall}/10 (no peer ratings received)</span></div>`;
      const teamLine = s.id in (result.teamAssignments || {})
        ? `<span class="badge" style="background:#636e72;">Team ${result.teamAssignments[s.id]}</span>` : '';
      div.innerHTML = `
        <h3>${escapeHtml(s.name)} — ${s.finalScore ?? s.overall}/10 ${teamLine}</h3>
        ${peerLine}
        <div class="score-row"><span>Clarity: ${s.clarity}</span><span>Fluency: ${s.fluency}</span>
             <span>Structure: ${s.structure}</span><span>Vocab: ${s.vocabulary}</span><span>Confidence: ${s.confidence}</span></div>
        <div class="score-row"><span>Filler words: ${s.fillerWordCount ?? '—'}</span><span>${s.wordsPerMinute ?? '—'} wpm</span></div>
        <div class="feedback">${escapeHtml(s.feedback || '')}</div>`;
      scoresListEl.appendChild(div);
    });
});

// ---------- Results (GD-specific AI rating) ----------
socket.on('gd-rating-result', (result) => {
  stopRecording();
  peerRatingScreen.classList.add('hidden');
  roomScreen.classList.add('hidden');
  resultsScreen.classList.remove('hidden');
  teamResultsEl.classList.add('hidden');

  const best = result.scores.find(s => s.id === result.bestContributorId) || result.scores[0];
  bestSpeakerEl.innerHTML = `🏆 Best Contributor: <strong>${escapeHtml(best?.name || '?')}</strong><br>
    <span style="font-weight:400;font-size:14px;">${escapeHtml(result.bestContributorReason || '')}</span>`;

  const mostActive = result.scores.find(s => s.id === result.mostActiveSpeakerId);
  const mostSilent = result.scores.find(s => s.id === result.mostSilentSpeakerId);
  gdParticipationBanner.classList.remove('hidden');
  gdParticipationBanner.innerHTML =
    `🗣️ Most active: <strong>${escapeHtml(mostActive?.name || '—')}</strong> (${mostActive?.totalSecondsSpoken ?? 0}s)` +
    ` &nbsp;·&nbsp; 🤫 Quietest: <strong>${escapeHtml(mostSilent?.name || '—')}</strong> (${mostSilent?.totalSecondsSpoken ?? 0}s)`;

  scoresListEl.innerHTML = '';
  result.scores
    .sort((a, b) => (b.finalScore ?? b.overall) - (a.finalScore ?? a.overall))
    .forEach(s => {
      const div = document.createElement('div');
      div.className = 'score-card';
      const peerLine = s.peerAverage !== null && s.peerAverage !== undefined
        ? `<div class="score-row"><span>AI: ${s.overall}/10</span><span>Peer: ${s.peerAverage}/10</span><span><strong>Final: ${s.finalScore}/10</strong></span></div>`
        : `<div class="score-row"><span>AI: ${s.overall}/10 (no peer ratings received)</span></div>`;
      div.innerHTML = `
        <h3>${escapeHtml(s.name)} — ${s.finalScore ?? s.overall}/10</h3>
        ${peerLine}
        <div class="score-row"><span>Content: ${s.contentQuality}</span><span>Balance: ${s.participationBalance}</span>
             <span>Clarity: ${s.clarity}</span><span>Confidence: ${s.confidence}</span></div>
        <div class="score-row"><span>Spoke: ${s.totalSecondsSpoken ?? 0}s across ${s.burstCount ?? 0} turn(s)</span><span>Filler words: ${s.fillerWordCount ?? '—'}</span><span>${s.wordsPerMinute ?? '—'} wpm</span></div>
        <div class="feedback">${escapeHtml(s.feedback || '')}</div>`;
      scoresListEl.appendChild(div);
    });
});

socket.on('rating-error', (msg) => {
  stopRecording();
  peerRatingScreen.classList.add('hidden');
  roomScreen.classList.add('hidden');
  resultsScreen.classList.remove('hidden');
  bestSpeakerEl.textContent = '⚠️ ' + msg;
  gdParticipationBanner.classList.add('hidden');
  scoresListEl.innerHTML = '';
});

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}