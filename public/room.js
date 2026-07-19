const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
const socket = io();

const params = new URLSearchParams(window.location.search);
const roomCode = params.get('code');
const isObserverRequest = params.get('observer') === '1';
const prefilledPassword = params.get('pw') || '';

let myId = null;
let myName = '';
let accessToken = null;
let localStream = null;
let isObserver = false;
const peers = {};
const audioEls = {};
let mediaRecorder = null;
let recordedChunks = [];
let isMySpeakingTurn = false;

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
  ],
};

// ---------- DOM ----------
const roomScreen = document.getElementById('room-screen');
const peerRatingScreen = document.getElementById('peer-rating-screen');
const resultsScreen = document.getElementById('results-screen');
const roomTitle = document.getElementById('room-title');
const roomStateBadge = document.getElementById('room-state');
const observerBanner = document.getElementById('observer-banner');
const membersGrid = document.getElementById('members-grid');
const turnBanner = document.getElementById('turn-banner');
const turnText = document.getElementById('turn-text');
const turnTimerEl = document.getElementById('turn-timer');
const micBtn = document.getElementById('mic-btn');
const startBtn = document.getElementById('start-btn');
const skipBtn = document.getElementById('skip-btn');
const statusLine = document.getElementById('status-line');
const bestSpeakerEl = document.getElementById('best-speaker');
const scoresListEl = document.getElementById('scores-list');
const peerRatingList = document.getElementById('peer-rating-list');
const submitRatingsBtn = document.getElementById('submit-ratings-btn');
const peerRatingProgress = document.getElementById('peer-rating-progress');

let turnCountdown = null;
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

  if (!isObserver) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      alert('Microphone access is required to join a room.');
      window.location.href = 'dashboard.html';
      return;
    }
  } else {
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
  renderMembers(summary);
});

socket.on('existing-peers', (peerList) => {
  peerList.forEach(p => createPeerConnection(p.id, true));
});

socket.on('peer-joined', ({ id }) => { createPeerConnection(id, false); });

socket.on('peer-left', ({ id }) => {
  if (peers[id]) { peers[id].close(); delete peers[id]; }
  if (audioEls[id]) { audioEls[id].remove(); delete audioEls[id]; }
});

// ---------- WebRTC ----------
function createPeerConnection(peerId, isInitiator) {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  peers[peerId] = pc;

  if (localStream) localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  pc.onicecandidate = (e) => { if (e.candidate) socket.emit('signal', { to: peerId, data: { candidate: e.candidate } }); };

  pc.ontrack = (e) => {
    let audioEl = audioEls[peerId];
    if (!audioEl) {
      audioEl = document.createElement('audio');
      audioEl.autoplay = true;
      document.body.appendChild(audioEl);
      audioEls[peerId] = audioEl;
    }
    audioEl.srcObject = e.streams[0];
  };

  if (isInitiator) {
    pc.onnegotiationneeded = async () => {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('signal', { to: peerId, data: { sdp: pc.localDescription } });
    };
  }
  return pc;
}

socket.on('signal', async ({ from, data }) => {
  let pc = peers[from];
  if (!pc) pc = createPeerConnection(from, false);
  if (data.sdp) {
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    if (data.sdp.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('signal', { to: from, data: { sdp: pc.localDescription } });
    }
  } else if (data.candidate) {
    try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch (e) {}
  }
});

// ---------- Room state ----------
socket.on('room-update', (summary) => {
  roomStateBadge.textContent = summary.state;
  renderMembers(summary);
  if (!isObserver) {
    startBtn.classList.toggle('hidden', summary.state !== 'waiting');
    startBtn.disabled = summary.members.length < 2;
    statusLine.textContent = summary.state === 'waiting'
      ? `${summary.members.length}/8 joined. Need at least 2 to start.`
      : '';
  }
});

function renderMembers(summary) {
  membersGrid.innerHTML = '';
  summary.members.forEach(m => {
    const div = document.createElement('div');
    div.className = 'member-card' + (m.id === summary.currentSpeaker ? ' speaking' : '');
    div.innerHTML = `<div class="avatar">${m.id === summary.currentSpeaker ? '🗣️' : '🙂'}</div>
                      <div class="mname">${escapeHtml(m.name)}${m.id === myId ? ' (you)' : ''}</div>`;
    membersGrid.appendChild(div);
  });
}

startBtn.onclick = () => socket.emit('start-session');
skipBtn.onclick = () => socket.emit('skip-turn');

micBtn.onclick = () => {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  track.enabled = !track.enabled;
  micBtn.textContent = track.enabled ? '🎤 Mute' : '🔇 Unmute';
};

// ---------- Turn / recording ----------
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
  recordedChunks = [];
  let options = { mimeType: 'audio/webm;codecs=opus' };
  if (!MediaRecorder.isTypeSupported(options.mimeType)) options = {};
  try { mediaRecorder = new MediaRecorder(localStream, options); }
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

// ---------- Peer rating ----------
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

// ---------- Results ----------
socket.on('rating-result', (result) => {
  stopRecording();
  peerRatingScreen.classList.add('hidden');
  roomScreen.classList.add('hidden');
  resultsScreen.classList.remove('hidden');

  const best = result.scores.find(s => s.id === result.bestSpeakerId) || result.scores[0];
  bestSpeakerEl.innerHTML = `🏆 Best Speaker: <strong>${escapeHtml(best?.name || '?')}</strong><br>
    <span style="font-weight:400;font-size:14px;">${escapeHtml(result.bestSpeakerReason || '')}</span>`;

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
        <div class="score-row"><span>Clarity: ${s.clarity}</span><span>Fluency: ${s.fluency}</span>
             <span>Structure: ${s.structure}</span><span>Vocab: ${s.vocabulary}</span><span>Confidence: ${s.confidence}</span></div>
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
  scoresListEl.innerHTML = '';
});

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}