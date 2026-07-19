const socket = io();

let myId = null;
let myName = '';
let roomId = '';
let localStream = null;
const peers = {}; // id -> RTCPeerConnection
const audioEls = {}; // id -> <audio>
let recognition = null;
let isMySpeakingTurn = false;
let currentSpeakerId = null;

const ICE_SERVERS = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

// ---------- DOM ----------
const joinScreen = document.getElementById('join-screen');
const roomScreen = document.getElementById('room-screen');
const resultsScreen = document.getElementById('results-screen');
const nameInput = document.getElementById('name-input');
const roomInput = document.getElementById('room-input');
const joinBtn = document.getElementById('join-btn');
const roomTitle = document.getElementById('room-title');
const roomStateBadge = document.getElementById('room-state');
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
const restartBtn = document.getElementById('restart-btn');

let turnCountdown = null;

// ---------- Join flow ----------
joinBtn.onclick = async () => {
  myName = nameInput.value.trim();
  roomId = roomInput.value.trim();
  if (!myName || !roomId) return alert('Enter your name and a room code.');

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    return alert('Microphone access is required to join a room.');
  }

  socket.emit('join-room', { roomId, name: myName });
};

socket.on('connect', () => { myId = socket.id; });

socket.on('join-error', (msg) => {
  alert(msg);
});

socket.on('existing-peers', (peerList) => {
  joinScreen.classList.add('hidden');
  roomScreen.classList.remove('hidden');
  roomTitle.textContent = `Room: ${roomId}`;
  peerList.forEach(p => createPeerConnection(p.id, true));
});

socket.on('peer-joined', ({ id, name }) => {
  createPeerConnection(id, false);
});

socket.on('peer-left', ({ id }) => {
  if (peers[id]) { peers[id].close(); delete peers[id]; }
  if (audioEls[id]) { audioEls[id].remove(); delete audioEls[id]; }
});

// ---------- WebRTC signaling ----------
function createPeerConnection(peerId, isInitiator) {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  peers[peerId] = pc;

  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('signal', { to: peerId, data: { candidate: e.candidate } });
  };

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

// ---------- Room state / UI ----------
socket.on('room-update', (summary) => {
  roomStateBadge.textContent = summary.state;
  currentSpeakerId = summary.currentSpeaker;
  renderMembers(summary);
  startBtn.classList.toggle('hidden', summary.state !== 'waiting');
  startBtn.disabled = summary.members.length < 2;
  statusLine.textContent = summary.state === 'waiting'
    ? `${summary.members.length}/8 joined. Need at least 2 to start.`
    : '';
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
  const track = localStream.getAudioTracks()[0];
  track.enabled = !track.enabled;
  micBtn.textContent = track.enabled ? '🎤 Mute' : '🔇 Unmute';
};

// ---------- Turn / speech recognition ----------
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

  if (isMySpeakingTurn) {
    startRecognition();
  } else {
    stopRecognition();
  }
});

function startRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    statusLine.textContent = 'Speech recognition not supported in this browser (try Chrome).';
    return;
  }
  recognition = new SR();
  recognition.continuous = true;
  recognition.interimResults = false;
  recognition.lang = 'en-US';
  recognition.onresult = (e) => {
    let text = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) text += e.results[i][0].transcript + ' ';
    }
    if (text.trim()) {
      console.log('Transcript chunk captured:', text.trim());
      socket.emit('transcript-chunk', { text: text.trim() });
    }
  };
  recognition.onerror = (e) => {
    console.error('Speech recognition error:', e.error);
    statusLine.textContent = 'Speech recognition error: ' + e.error;
  };
  recognition.onend = () => { if (isMySpeakingTurn) { try { recognition.start(); } catch (e) {} } };
  try { recognition.start(); } catch (e) { console.error('Could not start recognition:', e); }
}

function stopRecognition() {
  isMySpeakingTurn = false;
  if (recognition) { try { recognition.stop(); } catch (e) {} recognition = null; }
}

// ---------- Results ----------
socket.on('rating-result', (result) => {
  stopRecognition();
  roomScreen.classList.add('hidden');
  resultsScreen.classList.remove('hidden');

  const best = result.scores.find(s => s.id === result.bestSpeakerId) || result.scores[0];
  bestSpeakerEl.innerHTML = `🏆 Best Speaker: <strong>${escapeHtml(best?.name || '?')}</strong><br>
    <span style="font-weight:400;font-size:14px;">${escapeHtml(result.bestSpeakerReason || '')}</span>`;

  scoresListEl.innerHTML = '';
  result.scores
    .sort((a, b) => b.overall - a.overall)
    .forEach(s => {
      const div = document.createElement('div');
      div.className = 'score-card';
      div.innerHTML = `
        <h3>${escapeHtml(s.name)} — ${s.overall}/10</h3>
        <div class="score-row"><span>Clarity: ${s.clarity}</span><span>Fluency: ${s.fluency}</span>
             <span>Structure: ${s.structure}</span><span>Vocab: ${s.vocabulary}</span><span>Confidence: ${s.confidence}</span></div>
        <div class="feedback">${escapeHtml(s.feedback || '')}</div>`;
      scoresListEl.appendChild(div);
    });
});

socket.on('rating-error', (msg) => {
  stopRecognition();
  roomScreen.classList.add('hidden');
  resultsScreen.classList.remove('hidden');
  bestSpeakerEl.textContent = '⚠️ ' + msg;
  scoresListEl.innerHTML = '';
});

restartBtn.onclick = () => location.reload();

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}