const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

let accessToken = null;
let localStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let convTimerInterval = null;
let conversationId = null;

const setupPanel = document.getElementById('setup-panel');
const conversationPanel = document.getElementById('conversation-panel');
const resultPanel = document.getElementById('result-panel');
const chatLog = document.getElementById('chat-log');
const recordBtn = document.getElementById('record-answer-btn');
const stopBtn = document.getElementById('stop-answer-btn');
const recordingIndicator = document.getElementById('recording-indicator');
const convStatus = document.getElementById('conv-status');
const convTimerEl = document.getElementById('conv-timer');

(async function init() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { window.location.href = 'login.html'; return; }
  accessToken = session.access_token;

  const select = document.getElementById('topic-select');
  if (window.TOPIC_BANK) {
    Object.entries(window.TOPIC_BANK).forEach(([category, topics]) => {
      const group = document.createElement('optgroup');
      group.label = category;
      topics.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t; opt.textContent = t;
        group.appendChild(opt);
      });
      select.appendChild(group);
    });
  }
})();

document.getElementById('topic-select').onchange = (e) => {
  if (e.target.value) document.getElementById('topic-input').value = e.target.value;
};
document.getElementById('random-topic-btn').onclick = () => {
  if (!window.TOPIC_BANK) return;
  const all = Object.values(window.TOPIC_BANK).flat();
  document.getElementById('topic-input').value = all[Math.floor(Math.random() * all.length)];
  document.getElementById('topic-select').value = '';
};

function addBubble(text, who) {
  const div = document.createElement('div');
  div.className = `chat-bubble ${who}`;
  div.textContent = text;
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

document.getElementById('start-conversation-btn').onclick = async () => {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    alert('Microphone access is required.');
    return;
  }

  const topic = document.getElementById('topic-input').value.trim();
  convStatus.textContent = 'Starting conversation...';

  const resp = await fetch('/api/conversation/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
    body: JSON.stringify({ topic }),
  });
  const data = await resp.json();
  if (!resp.ok) { alert(data.error || 'Could not start conversation.'); return; }

  conversationId = data.conversationId;
  setupPanel.classList.add('hidden');
  conversationPanel.classList.remove('hidden');
  convStatus.textContent = '';
  addBubble(data.question, 'ai');
};

recordBtn.onclick = () => {
  recordedChunks = [];
  let options = { mimeType: 'audio/webm;codecs=opus' };
  if (!MediaRecorder.isTypeSupported(options.mimeType)) options = {};
  mediaRecorder = new MediaRecorder(localStream, options);
  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
  mediaRecorder.start();

  recordBtn.classList.add('hidden');
  stopBtn.classList.remove('hidden');
  recordingIndicator.classList.remove('hidden');

  let remaining = 60;
  convTimerEl.textContent = remaining;
  convTimerInterval = setInterval(() => {
    remaining -= 1;
    convTimerEl.textContent = Math.max(remaining, 0);
    if (remaining <= 0) sendAnswer();
  }, 1000);
};

stopBtn.onclick = sendAnswer;

function sendAnswer() {
  clearInterval(convTimerInterval);
  recordingIndicator.classList.add('hidden');
  stopBtn.classList.add('hidden');
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  mediaRecorder.onstop = uploadAnswer;
}

async function uploadAnswer() {
  convStatus.textContent = 'Transcribing your answer...';
  const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
  const buffer = await blob.arrayBuffer();

  try {
    const resp = await fetch(`/api/conversation/${conversationId}/answer`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm', 'Authorization': `Bearer ${accessToken}` },
      body: buffer,
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Something went wrong.');

    addBubble('(your answer was recorded)', 'user');
    convStatus.textContent = '';

    if (data.done) {
      localStream.getTracks().forEach(t => t.stop());
      showResult(data.result);
    } else {
      addBubble(data.question, 'ai');
      recordBtn.classList.remove('hidden');
    }
  } catch (err) {
    convStatus.textContent = '⚠️ ' + err.message;
    recordBtn.classList.remove('hidden');
  }
}

function showResult(r) {
  conversationPanel.classList.add('hidden');
  resultPanel.classList.remove('hidden');
  document.getElementById('result-score').textContent = `Score: ${r.overall}/10`;
  document.getElementById('result-clarity').textContent = `Clarity: ${r.clarity}`;
  document.getElementById('result-fluency').textContent = `Fluency: ${r.fluency}`;
  document.getElementById('result-structure').textContent = `Structure: ${r.structure}`;
  document.getElementById('result-vocab').textContent = `Vocab: ${r.vocabulary}`;
  document.getElementById('result-confidence').textContent = `Confidence: ${r.confidence}`;
  document.getElementById('result-filler').textContent = `Filler words: ${r.fillerCount}`;
  document.getElementById('result-wpm').textContent = `${r.wpm} wpm`;
  document.getElementById('result-feedback').textContent = r.feedback;
}

document.getElementById('practice-again-btn').onclick = () => window.location.reload();