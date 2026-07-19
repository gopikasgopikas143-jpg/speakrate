const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

let accessToken = null;
let localStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let recTimerInterval = null;

const setupPanel = document.getElementById('setup-panel');
const recordingPanel = document.getElementById('recording-panel');
const processingPanel = document.getElementById('processing-panel');
const resultPanel = document.getElementById('result-panel');
const recTimerEl = document.getElementById('rec-timer');

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

document.getElementById('start-recording-btn').onclick = async () => {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    alert('Microphone access is required.');
    return;
  }
  setupPanel.classList.add('hidden');
  recordingPanel.classList.remove('hidden');

  recordedChunks = [];
  let options = { mimeType: 'audio/webm;codecs=opus' };
  if (!MediaRecorder.isTypeSupported(options.mimeType)) options = {};
  mediaRecorder = new MediaRecorder(localStream, options);
  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
  mediaRecorder.onstop = submitRecording;
  mediaRecorder.start();

  let remaining = 60;
  recTimerEl.textContent = remaining;
  recTimerInterval = setInterval(() => {
    remaining -= 1;
    recTimerEl.textContent = Math.max(remaining, 0);
    if (remaining <= 0) stopRecording();
  }, 1000);
};

document.getElementById('stop-recording-btn').onclick = stopRecording;

function stopRecording() {
  clearInterval(recTimerInterval);
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  if (localStream) localStream.getTracks().forEach(t => t.stop());
}

async function submitRecording() {
  recordingPanel.classList.add('hidden');
  processingPanel.classList.remove('hidden');

  const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
  const buffer = await blob.arrayBuffer();
  const topic = document.getElementById('topic-input').value.trim();

  try {
    const resp = await fetch(`/api/solo/submit?topic=${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'audio/webm', 'Authorization': `Bearer ${accessToken}` },
      body: buffer,
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Could not process recording.');

    showResult(data.result);
  } catch (err) {
    processingPanel.classList.add('hidden');
    resultPanel.classList.remove('hidden');
    document.getElementById('result-score').textContent = '⚠️ ' + err.message;
  }
}

function showResult(r) {
  processingPanel.classList.add('hidden');
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

  const audioEl = document.getElementById('result-audio');
  if (r.audioUrl) { audioEl.src = r.audioUrl; audioEl.classList.remove('hidden'); }
}

document.getElementById('practice-again-btn').onclick = () => window.location.reload();