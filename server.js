require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6 });

app.use(express.json());
app.use(express.static('public'));

// ---------- Config ----------
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const MAX_ROOM_SIZE = 8;
const TURN_SECONDS = 60;
const PEER_RATING_SECONDS = 30;

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

// expose public (safe) config to the browser
app.get('/config.js', (req, res) => {
  res.type('application/javascript');
  res.send(
    `window.SUPABASE_URL = ${JSON.stringify(process.env.SUPABASE_URL || '')};\n` +
    `window.SUPABASE_ANON_KEY = ${JSON.stringify(process.env.SUPABASE_ANON_KEY || '')};\n`
  );
});

// ---------- Auth helpers ----------
async function verifyUser(token) {
  if (!token) return null;
  try {
    const { data, error } = await supabaseAdmin.auth.getUser(token);
    if (error || !data?.user) return null;
    return data.user;
  } catch (e) {
    return null;
  }
}

async function getProfile(userId) {
  const { data } = await supabaseAdmin.from('profiles').select('name, role').eq('id', userId).single();
  return data;
}

function bearerToken(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

function generateRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ---------- REST: room creation / admin room list ----------
app.post('/api/rooms', async (req, res) => {
  const user = await verifyUser(bearerToken(req));
  if (!user) return res.status(401).json({ error: 'Please sign in.' });

  const { name, password } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Room name is required.' });

  const roomCode = generateRoomCode();
  const passwordHash = password ? bcrypt.hashSync(password, 10) : null;

  const { error } = await supabaseAdmin.from('rooms').insert([{
    room_code: roomCode, name: name.trim(), password_hash: passwordHash, created_by: user.id,
  }]);
  if (error) return res.status(500).json({ error: error.message });

  res.json({ roomCode, name: name.trim() });
});

app.get('/api/rooms/active', async (req, res) => {
  const user = await verifyUser(bearerToken(req));
  if (!user) return res.status(401).json({ error: 'Please sign in.' });
  const profile = await getProfile(user.id);
  if (!profile || profile.role !== 'admin') return res.status(403).json({ error: 'Admin only.' });

  const active = Object.entries(rooms).map(([code, r]) => ({
    code, name: r.name,
    memberCount: Object.keys(r.members).length,
    observerCount: r.observers.size,
    state: r.state,
  }));
  res.json(active);
});

// ---------- In-memory live room state ----------
// rooms: { [roomCode]: {
//   dbId, name, passwordHash, members: {socketId: {name,userId,role}}, observers: Set<socketId>,
//   order: [socketId], turnIndex, transcripts: {socketId:text}, pendingTranscriptions: Set,
//   peerRatings: {raterSocketId: {targetSocketId: score}}, state, timer, peerTimer
// } }
const rooms = {};

function roomSummary(roomCode) {
  const room = rooms[roomCode];
  if (!room) return null;
  return {
    roomCode,
    name: room.name,
    members: Object.entries(room.members).map(([id, m]) => ({ id, name: m.name })),
    observerCount: room.observers.size,
    state: room.state,
    turnIndex: room.turnIndex,
    currentSpeaker: room.turnIndex >= 0 && room.order[room.turnIndex] ? room.order[room.turnIndex] : null,
  };
}

function broadcastRoom(roomCode) {
  io.to(roomCode).emit('room-update', roomSummary(roomCode));
}

function startNextTurn(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  const prevSpeakerId = room.turnIndex >= 0 ? room.order[room.turnIndex] : null;
  room.turnIndex += 1;

  if (prevSpeakerId) {
    room.pendingTranscriptions.add(prevSpeakerId);
    io.to(prevSpeakerId).emit('turn-end');
  }

  if (room.turnIndex >= room.order.length) {
    startPeerRating(roomCode);
    return;
  }

  room.state = 'speaking';
  const speakerId = room.order[room.turnIndex];
  io.to(roomCode).emit('turn-start', {
    speakerId,
    speakerName: room.members[speakerId]?.name,
    seconds: TURN_SECONDS,
  });
  broadcastRoom(roomCode);

  clearTimeout(room.timer);
  room.timer = setTimeout(() => startNextTurn(roomCode), TURN_SECONDS * 1000);
}

function startPeerRating(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  room.state = 'peer-rating';
  broadcastRoom(roomCode);
  io.to(roomCode).emit('peer-rating-start', {
    members: Object.entries(room.members).map(([id, m]) => ({ id, name: m.name })),
    seconds: PEER_RATING_SECONDS,
  });
  clearTimeout(room.peerTimer);
  room.peerTimer = setTimeout(() => finishPeerRating(roomCode), PEER_RATING_SECONDS * 1000);
}

function finishPeerRating(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.state !== 'peer-rating') return;
  clearTimeout(room.peerTimer);
  room.state = 'rating';
  broadcastRoom(roomCode);
  if (room.pendingTranscriptions.size === 0) runRating(roomCode);
}

async function runRating(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  const entries = Object.entries(room.transcripts)
    .map(([id, text]) => ({ id, name: room.members[id]?.name || 'Unknown', text: text || '(no speech captured)' }));

  console.log(`[${roomCode}] running rating. Transcript entries:`, entries.length, 'Key present:', !!GROQ_API_KEY);

  if (entries.length === 0 || !GROQ_API_KEY) {
    io.to(roomCode).emit('rating-error', 'No transcripts captured or API key missing.');
    room.state = 'done';
    broadcastRoom(roomCode);
    return;
  }

  const transcriptBlock = entries
    .map((e, i) => `Speaker ${i + 1} (name: "${e.name}", id: "${e.id}"):\n"""${e.text}"""`)
    .join('\n\n');

  const prompt = `You are judging a student speaking-practice session with EXACTLY ${entries.length} speakers. Below are transcripts from each speaker's turn (roughly 60 seconds each). Rate each speaker on: Clarity, Fluency (filler words/pauses), Structure, Vocabulary, and Confidence — each out of 10 — plus an Overall score out of 10. Give each speaker 1-2 sentences of constructive feedback. Then name the single best speaker overall.

CRITICAL: Your "scores" array MUST contain EXACTLY ${entries.length} objects — one for every single speaker id listed below (${entries.map(e => e.id).join(', ')}). Do not skip, merge, or omit any speaker, even if their transcript is short.

Respond ONLY with valid JSON, no markdown fences, in this exact shape:
{
  "scores": [
    {"id": "...", "name": "...", "clarity": 0, "fluency": 0, "structure": 0, "vocabulary": 0, "confidence": 0, "overall": 0, "feedback": "..."}
  ],
  "bestSpeakerId": "...",
  "bestSpeakerReason": "..."
}

Transcripts:
${transcriptBlock}`;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
      body: JSON.stringify({ model: GROQ_MODEL, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!response.ok) throw new Error(`Groq API ${response.status}: ${await response.text()}`);

    const data = await response.json();
    const raw = (data.choices?.[0]?.message?.content || '').trim()
      .replace(/^```json/i, '').replace(/```$/, '').trim();
    const result = JSON.parse(raw);

    // Fill in anyone the model dropped
    const returnedIds = new Set((result.scores || []).map(s => s.id));
    for (const e of entries) {
      if (!returnedIds.has(e.id)) {
        result.scores.push({
          id: e.id, name: e.name, clarity: 0, fluency: 0, structure: 0, vocabulary: 0, confidence: 0, overall: 0,
          feedback: 'Score unavailable — please re-run rating.',
        });
      }
    }

    // Blend in peer ratings: 60% AI overall + 40% peer average (peer 1-5 scaled to /10)
    for (const s of result.scores) {
      const received = Object.values(room.peerRatings)
        .map(r => r[s.id]).filter(v => typeof v === 'number');
      if (received.length > 0) {
        const peerAvg5 = received.reduce((a, b) => a + b, 0) / received.length;
        s.peerAverage = +(peerAvg5 * 2).toFixed(1); // scale 1-5 -> /10
        s.finalScore = +(0.6 * s.overall + 0.4 * s.peerAverage).toFixed(1);
      } else {
        s.peerAverage = null;
        s.finalScore = s.overall;
      }
    }

    // Recompute best speaker by blended final score
    const topScorer = [...result.scores].sort((a, b) => b.finalScore - a.finalScore)[0];
    if (topScorer) {
      result.bestSpeakerId = topScorer.id;
    }

    room.state = 'done';
    io.to(roomCode).emit('rating-result', result);
    broadcastRoom(roomCode);

    // Persist to Supabase (fire-and-forget, don't block the response to users)
    persistSessionResults(roomCode, room, result).catch(err =>
      console.error(`[${roomCode}] failed to persist session results:`, err.message)
    );
  } catch (err) {
    console.error('Rating error:', err);
    io.to(roomCode).emit('rating-error', 'Could not generate rating: ' + err.message);
    room.state = 'done';
    broadcastRoom(roomCode);
  }
}

async function persistSessionResults(roomCode, room, result) {
  const rows = result.scores.map(s => ({
    room_code: roomCode,
    room_name: room.name,
    user_id: room.members[s.id]?.userId || null,
    speaker_name: s.name,
    clarity: s.clarity, fluency: s.fluency, structure: s.structure,
    vocabulary: s.vocabulary, confidence: s.confidence,
    ai_overall: s.overall,
    peer_average: s.peerAverage,
    final_score: s.finalScore,
    feedback: s.feedback,
    is_best_speaker: s.id === result.bestSpeakerId,
  }));
  const { error } = await supabaseAdmin.from('session_results').insert(rows);
  if (error) throw error;
  console.log(`[${roomCode}] session results saved (${rows.length} rows)`);
}

// ---------- Socket.io ----------
io.on('connection', (socket) => {
  socket.on('join-room', async ({ roomCode, password, token, observerMode }) => {
    if (!roomCode) return socket.emit('join-error', 'Room code is required.');

    const user = await verifyUser(token);
    if (!user) return socket.emit('join-error', 'Please sign in again.');
    const profile = await getProfile(user.id);
    if (!profile) return socket.emit('join-error', 'Profile not found.');

    let room = rooms[roomCode];
    if (!room) {
      const { data: dbRoom } = await supabaseAdmin.from('rooms').select('*').eq('room_code', roomCode).single();
      if (!dbRoom) return socket.emit('join-error', 'Room not found. Ask the host to create it first.');
      room = rooms[roomCode] = {
        dbId: dbRoom.id, name: dbRoom.name, passwordHash: dbRoom.password_hash,
        members: {}, observers: new Set(), order: [], turnIndex: -1,
        transcripts: {}, pendingTranscriptions: new Set(), peerRatings: {},
        state: 'waiting', timer: null, peerTimer: null,
      };
    }

    const isAdmin = profile.role === 'admin';

    // Password check (admins bypass)
    if (room.passwordHash && !isAdmin) {
      if (!password || !bcrypt.compareSync(password, room.passwordHash)) {
        return socket.emit('join-error', 'Incorrect room password.');
      }
    }

    // Admin observer mode: watch only, no mic seat, not part of speaking order
    if (observerMode && isAdmin) {
      socket.join(roomCode);
      socket.data.roomCode = roomCode;
      socket.data.isObserver = true;
      room.observers.add(socket.id);
      socket.emit('observer-joined', roomSummary(roomCode));
      broadcastRoom(roomCode);
      return;
    }

    if (room.state !== 'waiting') return socket.emit('join-error', 'Session already in progress.');
    if (Object.keys(room.members).length >= MAX_ROOM_SIZE) return socket.emit('join-error', 'Room is full (max 8).');

    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.name = profile.name;
    room.members[socket.id] = { name: profile.name, userId: user.id, role: profile.role };

    const existingIds = Object.keys(room.members).filter(id => id !== socket.id);
    socket.emit('existing-peers', existingIds.map(id => ({ id, name: room.members[id].name })));
    socket.to(roomCode).emit('peer-joined', { id: socket.id, name: profile.name });

    broadcastRoom(roomCode);
  });

  socket.on('signal', ({ to, data }) => {
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('start-session', () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || room.state !== 'waiting' || socket.data.isObserver) return;
    room.order = Object.keys(room.members).sort(() => Math.random() - 0.5);
    room.turnIndex = -1;
    startNextTurn(roomCode);
  });

  socket.on('audio-recording', async (buffer) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;

    room.pendingTranscriptions.add(socket.id);
    io.to(roomCode).emit('transcribing-status', { name: socket.data.name });

    try {
      const form = new FormData();
      form.append('file', new Blob([buffer], { type: 'audio/webm' }), 'audio.webm');
      form.append('model', 'whisper-large-v3-turbo');

      const resp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${GROQ_API_KEY}` },
        body: form,
      });
      if (!resp.ok) throw new Error(`Whisper API ${resp.status}: ${await resp.text()}`);

      const data = await resp.json();
      room.transcripts[socket.id] = (room.transcripts[socket.id] || '') + ' ' + (data.text || '');
      console.log(`[${roomCode}] transcribed audio from ${socket.data.name}:`, data.text);
    } catch (err) {
      console.error(`[${roomCode}] transcription failed for ${socket.data.name}:`, err.message);
    } finally {
      room.pendingTranscriptions.delete(socket.id);
      if (room.state === 'rating' && room.pendingTranscriptions.size === 0) runRating(roomCode);
    }
  });

  socket.on('skip-turn', () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || room.order[room.turnIndex] !== socket.id) return;
    clearTimeout(room.timer);
    startNextTurn(roomCode);
  });

  socket.on('submit-peer-ratings', ({ ratings }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || room.state !== 'peer-rating' || socket.data.isObserver) return;

    room.peerRatings[socket.id] = ratings || {};
    io.to(roomCode).emit('peer-rating-progress', {
      submitted: Object.keys(room.peerRatings).length,
      total: Object.keys(room.members).length,
    });

    const memberIds = Object.keys(room.members);
    const submittedIds = Object.keys(room.peerRatings);
    if (memberIds.every(id => submittedIds.includes(id))) {
      finishPeerRating(roomCode);
    }
  });

  socket.on('disconnect', () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room) return;

    if (socket.data.isObserver) {
      room.observers.delete(socket.id);
      broadcastRoom(roomCode);
      return;
    }

    delete room.members[socket.id];
    socket.to(roomCode).emit('peer-left', { id: socket.id });
    if (Object.keys(room.members).length === 0 && room.observers.size === 0) {
      clearTimeout(room.timer);
      clearTimeout(room.peerTimer);
      delete rooms[roomCode];
    } else {
      broadcastRoom(roomCode);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SpeakRate running on port ${PORT}`));