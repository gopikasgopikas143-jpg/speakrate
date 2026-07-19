require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5e6 });

app.use(express.static('public'));

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.1-8b-instant';

const MAX_ROOM_SIZE = 8;
const TURN_SECONDS = 60;

// rooms: { [roomId]: { members: {socketId: {name}}, order: [socketId], turnIndex: -1,
//                        transcripts: {socketId: text}, state: 'waiting'|'speaking'|'rating'|'done', timer } }
const rooms = {};

function roomSummary(roomId) {
  const room = rooms[roomId];
  if (!room) return null;
  return {
    roomId,
    members: Object.entries(room.members).map(([id, m]) => ({ id, name: m.name })),
    state: room.state,
    turnIndex: room.turnIndex,
    currentSpeaker: room.turnIndex >= 0 ? room.order[room.turnIndex] : null,
  };
}

function broadcastRoom(roomId) {
  io.to(roomId).emit('room-update', roomSummary(roomId));
}

function startNextTurn(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const prevSpeakerId = room.turnIndex >= 0 ? room.order[room.turnIndex] : null;
  room.turnIndex += 1;

  if (prevSpeakerId) io.to(prevSpeakerId).emit('turn-end');

  if (room.turnIndex >= room.order.length) {
    room.state = 'rating';
    broadcastRoom(roomId);
    if (room.pendingTranscriptions.size === 0) runRating(roomId);
    return;
  }

  room.state = 'speaking';
  const speakerId = room.order[room.turnIndex];
  io.to(roomId).emit('turn-start', {
    speakerId,
    speakerName: room.members[speakerId]?.name,
    seconds: TURN_SECONDS,
  });
  broadcastRoom(roomId);

  clearTimeout(room.timer);
  room.timer = setTimeout(() => startNextTurn(roomId), TURN_SECONDS * 1000);
}

async function runRating(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  const entries = Object.entries(room.transcripts)
    .map(([id, text]) => ({ id, name: room.members[id]?.name || 'Unknown', text: text || '(no speech captured)' }));

  console.log(`[${roomId}] running rating. Transcript entries:`, entries.length, 'Key present:', !!GROQ_API_KEY);

  if (entries.length === 0 || !GROQ_API_KEY) {
    io.to(roomId).emit('rating-error', 'No transcripts captured or API key missing.');
    room.state = 'done';
    broadcastRoom(roomId);
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
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Groq API ${response.status}: ${errText}`);
    }

    const data = await response.json();
    const raw = (data.choices?.[0]?.message?.content || '').trim()
      .replace(/^```json/i, '').replace(/```$/, '').trim();
    const result = JSON.parse(raw);

    // Safety net: if the model dropped any speaker, fill them in so nobody silently disappears
    const returnedIds = new Set((result.scores || []).map(s => s.id));
    for (const e of entries) {
      if (!returnedIds.has(e.id)) {
        console.warn(`[${roomId}] model omitted speaker ${e.name} (${e.id}) — adding placeholder`);
        result.scores.push({
          id: e.id, name: e.name, clarity: 0, fluency: 0, structure: 0,
          vocabulary: 0, confidence: 0, overall: 0,
          feedback: 'Score unavailable — please re-run rating.',
        });
      }
    }

    room.state = 'done';
    io.to(roomId).emit('rating-result', result);
    broadcastRoom(roomId);
  } catch (err) {
    console.error('Rating error:', err);
    io.to(roomId).emit('rating-error', 'Could not generate rating: ' + err.message);
    room.state = 'done';
    broadcastRoom(roomId);
  }
}

io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, name }) => {
    if (!roomId || !name) return;
    let room = rooms[roomId];
    if (!room) {
      room = rooms[roomId] = {
        members: {}, order: [], turnIndex: -1,
        transcripts: {}, state: 'waiting', timer: null,
        pendingTranscriptions: new Set(),
      };
    }
    if (Object.keys(room.members).length >= MAX_ROOM_SIZE) {
      socket.emit('join-error', 'Room is full (max 8).');
      return;
    }
    if (room.state !== 'waiting') {
      socket.emit('join-error', 'Session already in progress.');
      return;
    }

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.name = name;
    room.members[socket.id] = { name };

    // tell existing peers about the newcomer, and newcomer about existing peers
    const existingIds = Object.keys(room.members).filter(id => id !== socket.id);
    socket.emit('existing-peers', existingIds.map(id => ({ id, name: room.members[id].name })));
    socket.to(roomId).emit('peer-joined', { id: socket.id, name });

    broadcastRoom(roomId);
  });

  // WebRTC signaling relay
  socket.on('signal', ({ to, data }) => {
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('start-session', () => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room || room.state !== 'waiting') return;
    room.order = Object.keys(room.members).sort(() => Math.random() - 0.5);
    room.turnIndex = -1;
    startNextTurn(roomId);
  });

  socket.on('audio-recording', async (buffer) => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room) return;

    room.pendingTranscriptions.add(socket.id);
    io.to(roomId).emit('transcribing-status', { name: socket.data.name });

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
      console.log(`[${roomId}] transcribed audio from ${socket.data.name}:`, data.text);
    } catch (err) {
      console.error(`[${roomId}] transcription failed for ${socket.data.name}:`, err.message);
    } finally {
      room.pendingTranscriptions.delete(socket.id);
      if (room.state === 'rating' && room.pendingTranscriptions.size === 0) {
        runRating(roomId);
      }
    }
  });

  socket.on('skip-turn', () => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room || room.order[room.turnIndex] !== socket.id) return;
    clearTimeout(room.timer);
    startNextTurn(roomId);
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room) return;
    delete room.members[socket.id];
    socket.to(roomId).emit('peer-left', { id: socket.id });
    if (Object.keys(room.members).length === 0) {
      clearTimeout(room.timer);
      delete rooms[roomId];
    } else {
      broadcastRoom(roomId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SpeakRate running on port ${PORT}`));