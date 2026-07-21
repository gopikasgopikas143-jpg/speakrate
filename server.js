require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 5e6,
  connectionStateRecovery: {
    // Reconnecting within this window hands the client back the SAME socket.id
    // (Socket.IO restores socket.data too, e.g. socket.data.roomCode). Combined
    // with the disconnect grace-period below, this is what stops brief wifi
    // drops / laptop sleep from ejecting someone from a live room.
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true,
  },
});

app.use(express.json());
app.use(express.static('public'));

// ---------- Config ----------
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const MAX_ROOM_SIZE = 8;
const TURN_SECONDS = 60;
const PEER_RATING_SECONDS = 30;
// How long we wait after a socket disconnects before treating it as a real
// departure. Covers brief wifi drops / laptop sleep / tab backgrounding —
// the far more common case in a live classroom than someone actually leaving.
const DISCONNECT_GRACE_MS = 15 * 1000;

// ---------- Filler word / WPM analytics (Phase 2) ----------
const SINGLE_TOKEN_FILLERS = new Set(['um', 'uh', 'like', 'so', 'actually']);
const PHRASE_FILLER_REGEX = /\byou know\b/g;

function computeSpeechStats(text) {
  const lower = (text || '').toLowerCase();
  const words = lower.match(/[a-z']+/g) || [];
  let fillerCount = 0;
  for (const w of words) {
    if (SINGLE_TOKEN_FILLERS.has(w)) fillerCount += 1;
  }
  const phraseMatches = lower.match(PHRASE_FILLER_REGEX);
  if (phraseMatches) fillerCount += phraseMatches.length;

  const minutes = TURN_SECONDS / 60;
  const wpm = minutes > 0 ? +(words.length / minutes).toFixed(1) : 0;
  return { fillerCount, wpm };
}

// ---------- Phase 3: reusable Groq helpers (solo practice + AI conversation) ----------
async function transcribeBuffer(buffer) {
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
  return data.text || '';
}

async function callGroqJson(prompt) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({ model: GROQ_MODEL, max_tokens: 1200, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!response.ok) throw new Error(`Groq API ${response.status}: ${await response.text()}`);
  const data = await response.json();
  const raw = (data.choices?.[0]?.message?.content || '').trim()
    .replace(/^```json/i, '').replace(/```$/, '').trim();
  return JSON.parse(raw);
}

async function callGroqText(prompt) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({ model: GROQ_MODEL, max_tokens: 200, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!response.ok) throw new Error(`Groq API ${response.status}: ${await response.text()}`);
  const data = await response.json();
  return (data.choices?.[0]?.message?.content || '').trim().replace(/^"|"$/g, '');
}

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

// Uploads a recorded audio buffer to the 'recordings' Supabase Storage
// bucket and returns its public URL, or null if the upload fails (a failed
// upload should never block transcription/rating — replay is a bonus, not
// a required part of the flow).
async function uploadRecording(buffer, pathHint) {
  try {
    const path = `${pathHint}-${Date.now()}.webm`;
    const { error } = await supabaseAdmin.storage.from('recordings').upload(path, buffer, {
      contentType: 'audio/webm',
      upsert: false,
    });
    if (error) throw error;
    const { data } = supabaseAdmin.storage.from('recordings').getPublicUrl(path);
    return data?.publicUrl || null;
  } catch (err) {
    console.error('Recording upload failed:', err.message);
    return null;
  }
}

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

  const { name, password, topic, teamMode } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'Room name is required.' });

  const roomCode = generateRoomCode();
  const passwordHash = password ? bcrypt.hashSync(password, 10) : null;

  const { error } = await supabaseAdmin.from('rooms').insert([{
    room_code: roomCode, name: name.trim(), password_hash: passwordHash, created_by: user.id,
    topic: topic && topic.trim() ? topic.trim() : null, team_mode: !!teamMode,
  }]);
  if (error) return res.status(500).json({ error: error.message });

  res.json({ roomCode, name: name.trim(), topic: topic || null, teamMode: !!teamMode });
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

// Any signed-in user can browse currently-live rooms to join (no password shown, just whether one's needed)
app.get('/api/rooms/browse', async (req, res) => {
  const user = await verifyUser(bearerToken(req));
  if (!user) return res.status(401).json({ error: 'Please sign in.' });

  const active = Object.entries(rooms)
    .filter(([, r]) => r.state === 'waiting' && Object.keys(r.members).length < MAX_ROOM_SIZE)
    .map(([code, r]) => ({
      code, name: r.name,
      memberCount: Object.keys(r.members).length,
      hasPassword: !!r.passwordHash,
    }));
  res.json(active);
});

// Rooms the current user has created, with live status if currently active
app.get('/api/rooms/mine', async (req, res) => {
  const user = await verifyUser(bearerToken(req));
  if (!user) return res.status(401).json({ error: 'Please sign in.' });

  const { data, error } = await supabaseAdmin
    .from('rooms')
    .select('room_code, name, created_at')
    .eq('created_by', user.id)
    .order('created_at', { ascending: false })
    .limit(10);
  if (error) return res.status(500).json({ error: error.message });

  const withStatus = (data || []).map(r => {
    const live = rooms[r.room_code];
    return {
      code: r.room_code, name: r.name, createdAt: r.created_at,
      isLive: !!live,
      memberCount: live ? Object.keys(live.members).length : 0,
      state: live ? live.state : 'not started',
    };
  });
  res.json(withStatus);
});

// Delete a room you created. Only allowed while it isn't currently live
// with other people in it, to avoid yanking a room out from under a
// session that's in progress.
app.delete('/api/rooms/:code', async (req, res) => {
  const user = await verifyUser(bearerToken(req));
  if (!user) return res.status(401).json({ error: 'Please sign in.' });

  const roomCode = req.params.code;
  const { data: dbRoom, error: fetchError } = await supabaseAdmin
    .from('rooms')
    .select('id, created_by')
    .eq('room_code', roomCode)
    .single();
  if (fetchError || !dbRoom) return res.status(404).json({ error: 'Room not found.' });
  if (dbRoom.created_by !== user.id) return res.status(403).json({ error: 'You can only delete rooms you created.' });

  const live = rooms[roomCode];
  if (live && Object.keys(live.members).length > 0) {
    return res.status(409).json({ error: 'This room is currently in use — it can\'t be deleted right now.' });
  }

  const { error: deleteError } = await supabaseAdmin.from('rooms').delete().eq('room_code', roomCode);
  if (deleteError) return res.status(500).json({ error: deleteError.message });

  if (live) {
    clearTimeout(live.timer);
    clearTimeout(live.peerTimer);
    delete rooms[roomCode];
  }

  res.json({ success: true });
});

// ---------- Phase 2: Leaderboard ----------
function weekAgoIso() {
  return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
}

app.get('/api/leaderboard', async (req, res) => {
  const user = await verifyUser(bearerToken(req));
  if (!user) return res.status(401).json({ error: 'Please sign in.' });

  const period = req.query.period === 'week' ? 'week' : 'all';
  let query = supabaseAdmin.from('session_results').select('user_id, final_score, created_at, session_type');
  if (period === 'week') query = query.gte('created_at', weekAgoIso());

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const byUser = {};
  for (const row of data || []) {
    if (!row.user_id) continue;
    if (!byUser[row.user_id]) byUser[row.user_id] = { total: 0, count: 0, types: new Set() };
    byUser[row.user_id].total += row.final_score || 0;
    byUser[row.user_id].count += 1;
    byUser[row.user_id].types.add(row.session_type || 'room');
  }
  const userIds = Object.keys(byUser);
  if (userIds.length === 0) return res.json([]);

  const { data: profiles } = await supabaseAdmin.from('profiles').select('id, name').in('id', userIds);
  const nameMap = Object.fromEntries((profiles || []).map(p => [p.id, p.name]));

  const typeOrder = ['room', 'solo', 'conversation'];
  const rows = userIds
    .map(id => ({
      userId: id,
      name: nameMap[id] || 'Unknown',
      avgFinalScore: +(byUser[id].total / byUser[id].count).toFixed(2),
      sessionCount: byUser[id].count,
      types: typeOrder.filter(t => byUser[id].types.has(t)),
    }))
    .sort((a, b) => b.avgFinalScore - a.avgFinalScore)
    .map((r, i) => ({ rank: i + 1, ...r }));

  res.json(rows);
});

// Teams don't have a persistent identity across rooms (Team A in one room
// isn't Team B in another) — so "team leaderboard" is ranked per
// room-session, i.e. each row is one team's average final_score in one
// completed team-mode session. See build summary for this call.
app.get('/api/leaderboard/teams', async (req, res) => {
  const user = await verifyUser(bearerToken(req));
  if (!user) return res.status(401).json({ error: 'Please sign in.' });

  const period = req.query.period === 'week' ? 'week' : 'all';
  let query = supabaseAdmin
    .from('session_results')
    .select('room_code, room_name, team, final_score, created_at')
    .not('team', 'is', null);
  if (period === 'week') query = query.gte('created_at', weekAgoIso());

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  const byTeam = {};
  for (const row of data || []) {
    const key = `${row.room_code}::${row.team}`;
    if (!byTeam[key]) {
      byTeam[key] = { roomCode: row.room_code, roomName: row.room_name, team: row.team, total: 0, count: 0 };
    }
    byTeam[key].total += row.final_score || 0;
    byTeam[key].count += 1;
  }

  const rows = Object.values(byTeam)
    .map(t => ({
      roomCode: t.roomCode, roomName: t.roomName, team: t.team,
      avgScore: +(t.total / t.count).toFixed(2), memberCount: t.count,
    }))
    .sort((a, b) => b.avgScore - a.avgScore)
    .map((r, i) => ({ rank: i + 1, ...r }));

  res.json(rows);
});

// ---------- Phase 2: My History ----------
app.get('/api/history/mine', async (req, res) => {
  const user = await verifyUser(bearerToken(req));
  if (!user) return res.status(401).json({ error: 'Please sign in.' });

  const { data, error } = await supabaseAdmin
    .from('session_results')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) return res.status(500).json({ error: error.message });

  res.json(data || []);
});

// ---------- Phase 2: Delete a history entry ----------
app.delete('/api/history/:id', async (req, res) => {
  const user = await verifyUser(bearerToken(req));
  if (!user) return res.status(401).json({ error: 'Please sign in.' });

  const { id } = req.params;
  const { data: row, error: fetchError } = await supabaseAdmin
    .from('session_results')
    .select('id, user_id')
    .eq('id', id)
    .single();
  if (fetchError || !row) return res.status(404).json({ error: 'Session not found.' });
  if (row.user_id !== user.id) return res.status(403).json({ error: 'You can only delete your own sessions.' });

  // Some badges (e.g. "Filler Words Cut in Half") reference the session they
  // were earned from via badges.session_id, which has a foreign key to this
  // table — delete those first or the session_results delete gets rejected.
  const { error: badgeDeleteError } = await supabaseAdmin.from('badges').delete().eq('session_id', id);
  if (badgeDeleteError) return res.status(500).json({ error: badgeDeleteError.message });

  const { error: deleteError } = await supabaseAdmin.from('session_results').delete().eq('id', id);
  if (deleteError) return res.status(500).json({ error: deleteError.message });

  res.json({ success: true });
});

// ---------- Phase 2: Badges ----------
app.get('/api/badges/mine', async (req, res) => {
  const user = await verifyUser(bearerToken(req));
  if (!user) return res.status(401).json({ error: 'Please sign in.' });

  const { data, error } = await supabaseAdmin
    .from('badges')
    .select('badge_type, awarded_at')
    .eq('user_id', user.id)
    .order('awarded_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });

  res.json(data || []);
});

// ---------- Phase 3: Solo Practice ----------
app.post('/api/solo/submit', express.raw({ type: 'audio/webm', limit: '10mb' }), async (req, res) => {
  const user = await verifyUser(bearerToken(req));
  if (!user) return res.status(401).json({ error: 'Please sign in.' });
  const profile = await getProfile(user.id);

  const topic = (req.query.topic || '').toString().slice(0, 200) || null;
  const buffer = req.body;
  if (!buffer || !buffer.length) return res.status(400).json({ error: 'No audio received.' });

  try {
    const text = await transcribeBuffer(buffer);
    const uploadPromise = uploadRecording(buffer, `solo-${user.id}`);

    const prompt = `You are an encouraging speaking coach for a student practicing English on their own — no audience, no comparison to other speakers, this is personal practice. Topic: "${topic || 'freely chosen by the student'}". Their ~60-second spoken transcript:
"""${text || '(no speech captured)'}"""

Rate them on Clarity, Fluency, Structure, Vocabulary, and Confidence (each /10), plus an Overall /10. Then give 2-3 sentences of warm, specific, encouraging feedback — this student may be a beginner building confidence, so be honest but supportive, and mention one thing they did well before suggesting an improvement.

Respond ONLY with valid JSON, no markdown fences:
{"clarity":0,"fluency":0,"structure":0,"vocabulary":0,"confidence":0,"overall":0,"feedback":"..."}`;

    const aiResult = await callGroqJson(prompt);
    const stats = computeSpeechStats(text);
    const audioUrl = await uploadPromise;

    const row = {
      room_code: null, room_name: null, session_type: 'solo', topic,
      user_id: user.id, speaker_name: profile?.name || user.email,
      clarity: aiResult.clarity, fluency: aiResult.fluency, structure: aiResult.structure,
      vocabulary: aiResult.vocabulary, confidence: aiResult.confidence, ai_overall: aiResult.overall,
      peer_average: null, final_score: aiResult.overall, feedback: aiResult.feedback,
      is_best_speaker: false, team: null,
      filler_word_count: stats.fillerCount, words_per_minute: stats.wpm,
      audio_url: audioUrl,
    };
    const { data: inserted, error } = await supabaseAdmin.from('session_results').insert([row]).select().single();
    if (error) throw error;

    checkAndAwardBadges([user.id]).catch(err => console.error('Solo badge check failed:', err.message));

    res.json({ transcript: text, result: { ...aiResult, ...stats, audioUrl }, sessionId: inserted.id });
  } catch (err) {
    console.error('Solo practice error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Phase 3: AI Conversation Partner ----------
// In-memory only (like live room state) — a conversation is short-lived
// and doesn't need to survive a server restart. Roughly 1 (opening
// question) + N whisper calls + (N-1) follow-up-question calls + 1 final
// rating call for an N-exchange conversation — e.g. 6 exchanges = 13 Groq
// calls total for one full session. Comfortably inside free-tier limits
// at class scale; keep an eye on this if usage grows a lot.
const conversations = {};
const CONVERSATION_MAX_EXCHANGES = 6;

app.post('/api/conversation/start', async (req, res) => {
  const user = await verifyUser(bearerToken(req));
  if (!user) return res.status(401).json({ error: 'Please sign in.' });
  const topic = (req.body?.topic || '').toString().slice(0, 200) || 'anything you like';

  try {
    const question = await callGroqText(
      `You are a friendly, encouraging English-conversation partner helping a beginner student practice speaking. Topic: "${topic}". Ask ONE simple, warm opening question to get them talking — one sentence, no preamble, no quotation marks.`
    );
    const conversationId = crypto.randomUUID();
    conversations[conversationId] = {
      userId: user.id, topic, exchanges: [], audioUrls: [], currentQuestion: question,
    };
    res.json({ conversationId, question });
  } catch (err) {
    console.error('Conversation start error:', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/conversation/:id/answer', express.raw({ type: 'audio/webm', limit: '10mb' }), async (req, res) => {
  const user = await verifyUser(bearerToken(req));
  if (!user) return res.status(401).json({ error: 'Please sign in.' });

  const convo = conversations[req.params.id];
  if (!convo || convo.userId !== user.id) return res.status(404).json({ error: 'Conversation not found or expired.' });

  const buffer = req.body;
  if (!buffer || !buffer.length) return res.status(400).json({ error: 'No audio received.' });

  try {
    const answerText = await transcribeBuffer(buffer);
    uploadRecording(buffer, `conv-${req.params.id}-${convo.exchanges.length}`).then(url => {
      if (url) convo.audioUrls.push(url);
    });

    convo.exchanges.push({ question: convo.currentQuestion, answer: answerText });

    if (convo.exchanges.length >= CONVERSATION_MAX_EXCHANGES) {
      const transcriptBlock = convo.exchanges
        .map((e, i) => `Q${i + 1}: ${e.question}\nA${i + 1}: ${e.answer}`).join('\n\n');
      const prompt = `You are an encouraging speaking coach reviewing a practice conversation with a beginner English student. Topic: "${convo.topic}". Here is the full exchange:

${transcriptBlock}

Rate their overall speaking across the whole conversation on Clarity, Fluency, Structure, Vocabulary, and Confidence (each /10), plus an Overall /10. Give 2-3 sentences of warm, specific, encouraging feedback highlighting their progress and one area to work on.

Respond ONLY with valid JSON, no markdown fences:
{"clarity":0,"fluency":0,"structure":0,"vocabulary":0,"confidence":0,"overall":0,"feedback":"..."}`;

      const aiResult = await callGroqJson(prompt);
      const allAnswersText = convo.exchanges.map(e => e.answer).join(' ');
      const stats = computeSpeechStats(allAnswersText);
      const profile = await getProfile(user.id);

      const row = {
        room_code: null, room_name: null, session_type: 'conversation', topic: convo.topic,
        user_id: user.id, speaker_name: profile?.name || user.email,
        clarity: aiResult.clarity, fluency: aiResult.fluency, structure: aiResult.structure,
        vocabulary: aiResult.vocabulary, confidence: aiResult.confidence, ai_overall: aiResult.overall,
        peer_average: null, final_score: aiResult.overall, feedback: aiResult.feedback,
        is_best_speaker: false, team: null,
        filler_word_count: stats.fillerCount, words_per_minute: stats.wpm,
        audio_url: JSON.stringify(convo.audioUrls),
      };
      const { error } = await supabaseAdmin.from('session_results').insert([row]);
      if (error) console.error('Failed to persist conversation session:', error.message);
      else checkAndAwardBadges([user.id]).catch(e => console.error('Conversation badge check failed:', e.message));

      const exchanges = convo.exchanges;
      delete conversations[req.params.id];
      return res.json({ done: true, exchanges, result: { ...aiResult, ...stats } });
    }

    const historyBlock = convo.exchanges.map(e => `Q: ${e.question}\nA: ${e.answer}`).join('\n\n');
    const nextQuestion = await callGroqText(
      `You are a friendly, encouraging English-conversation partner helping a beginner student practice speaking. Topic: "${convo.topic}". Conversation so far:

${historyBlock}

Ask ONE natural follow-up question that builds on what they just said — one sentence, no preamble, no quotation marks, keep it simple and encouraging.`
    );
    convo.currentQuestion = nextQuestion;
    res.json({ done: false, question: nextQuestion, exchangeCount: convo.exchanges.length });
  } catch (err) {
    console.error('Conversation answer error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- In-memory live room state ----------
// rooms: { [roomCode]: {
//   dbId, name, passwordHash, hostUserId, topic, teamMode,
//   members: {socketId: {name,userId,role}}, observers: Set<socketId>,
//   teams: {socketId: 'A'|'B'}, order: [socketId], turnIndex,
//   transcripts: {socketId:text}, pendingTranscriptions: Set,
//   peerRatings: {raterSocketId: {targetSocketId: score}}, state, timer, peerTimer
// } }
const rooms = {};

function roomSummary(roomCode) {
  const room = rooms[roomCode];
  if (!room) return null;
  return {
    roomCode,
    name: room.name,
    topic: room.topic || null,
    teamMode: room.teamMode,
    members: Object.entries(room.members).map(([id, m]) => ({ id, name: m.name, team: room.teams[id] || null })),
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

  beginTurnAtCurrentIndex(roomCode);
}

// Starts whoever is at room.turnIndex right now, without touching the
// previous speaker's pending-transcription bookkeeping. Used both by
// startNextTurn (after normally advancing) and by the disconnect handler
// (when we need to skip straight past someone who just left mid-turn,
// without waiting on audio that will never arrive).
function beginTurnAtCurrentIndex(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

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
        s.finalScore = +(0.4 * s.overall + 0.6 * s.peerAverage).toFixed(1);
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

    // Filler word count + words-per-minute, straight from the transcript
    // we already have in memory (Phase 2)
    for (const s of result.scores) {
      const stats = computeSpeechStats(room.transcripts[s.id]);
      s.fillerWordCount = stats.fillerCount;
      s.wordsPerMinute = stats.wpm;
    }

    // Team Mode results (Phase 2)
    if (room.teamMode) {
      const teamScores = { A: [], B: [] };
      for (const s of result.scores) {
        const team = room.teams[s.id];
        if (team === 'A' || team === 'B') teamScores[team].push(s.finalScore);
      }
      const avg = (arr) => arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : null;
      result.teamMode = true;
      result.teamResults = { A: avg(teamScores.A), B: avg(teamScores.B) };
      result.teamAssignments = { ...room.teams };
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
    session_type: 'room',
    topic: room.topic || null,
    user_id: room.memberInfo[s.id]?.userId || null,
    speaker_name: s.name,
    clarity: s.clarity, fluency: s.fluency, structure: s.structure,
    vocabulary: s.vocabulary, confidence: s.confidence,
    ai_overall: s.overall,
    peer_average: s.peerAverage,
    final_score: s.finalScore,
    feedback: s.feedback,
    is_best_speaker: s.id === result.bestSpeakerId,
    team: room.teamMode ? (room.teams[s.id] || null) : null,
    filler_word_count: s.fillerWordCount ?? null,
    words_per_minute: s.wordsPerMinute ?? null,
    audio_url: (room.audioUrls && room.audioUrls[s.id]) || null,
  }));
  const { error } = await supabaseAdmin.from('session_results').insert(rows);
  if (error) throw error;
  console.log(`[${roomCode}] session results saved (${rows.length} rows)`);

  const userIds = [...new Set(rows.map(r => r.user_id).filter(Boolean))];
  checkAndAwardBadges(userIds).catch(err =>
    console.error(`[${roomCode}] badge check failed:`, err.message)
  );
}

// ---------- Phase 2: Gamification / badges ----------
// Awarding is checked right after each session is persisted rather than on
// a schedule/cron — there's no scheduler in this single-process app, and
// "recompute after every session" is always at-least-as-fresh as any
// periodic job would be, with far less moving parts. Both badge types use a
// rolling 7-day window (not a calendar week) so they're consistent with the
// Leaderboard's "This week" filter and don't reset awkwardly mid-week.
async function checkAndAwardBadges(userIds) {
  for (const userId of userIds) {
    await checkStreakBadge(userId);
    await checkFillerImprovementBadge(userId);
    await checkFluencyClimbBadge(userId);
  }
  await checkTopSpeakerBadge();
}

async function checkStreakBadge(userId) {
  const since = weekAgoIso();
  const { data, error } = await supabaseAdmin
    .from('session_results')
    .select('created_at')
    .eq('user_id', userId)
    .gte('created_at', since);
  if (error || !data) return;

  const distinctDays = new Set(data.map(r => r.created_at.slice(0, 10)));
  if (distinctDays.size < 5) return;

  // Don't re-award while the same 7-day streak is still active
  const { data: existing } = await supabaseAdmin
    .from('badges')
    .select('id')
    .eq('user_id', userId)
    .eq('badge_type', '5-Day Streak')
    .gte('awarded_at', since);
  if (existing && existing.length > 0) return;

  await supabaseAdmin.from('badges').insert([{ user_id: userId, badge_type: '5-Day Streak' }]);
}

async function checkTopSpeakerBadge() {
  const since = weekAgoIso();
  const { data, error } = await supabaseAdmin
    .from('session_results')
    .select('user_id, final_score')
    .eq('session_type', 'room')
    .gte('created_at', since);
  if (error || !data || data.length === 0) return;

  const byUser = {};
  for (const row of data) {
    if (!row.user_id) continue;
    if (!byUser[row.user_id]) byUser[row.user_id] = { total: 0, count: 0 };
    byUser[row.user_id].total += row.final_score || 0;
    byUser[row.user_id].count += 1;
  }

  let topUser = null, topAvg = -Infinity;
  for (const [uid, v] of Object.entries(byUser)) {
    const avg = v.total / v.count;
    if (avg > topAvg) { topAvg = avg; topUser = uid; }
  }
  if (!topUser) return;

  const { data: existing } = await supabaseAdmin
    .from('badges')
    .select('id')
    .eq('user_id', topUser)
    .eq('badge_type', 'Top Speaker of the Week')
    .gte('awarded_at', since);
  if (existing && existing.length > 0) return;

  await supabaseAdmin.from('badges').insert([{ user_id: topUser, badge_type: 'Top Speaker of the Week' }]);
}

// ---------- Phase 3: skill-improvement badges ----------
// Both compare a user's LATEST session against the average of their
// previous 5, so they need at least 6 sessions of any type (room, solo, or
// conversation all count towards personal progress) to have a real
// baseline. Each is tied to the specific session_id that earned it via
// badges.session_id, so re-running this after the same session never
// double-awards it — but a genuinely new improvement moment (a later
// session that also clears the bar) earns it again, unlike the Phase 2
// time-window badges which are capped per rolling week.
async function checkFillerImprovementBadge(userId) {
  const { data, error } = await supabaseAdmin
    .from('session_results')
    .select('id, filler_word_count, created_at')
    .eq('user_id', userId)
    .not('filler_word_count', 'is', null)
    .order('created_at', { ascending: false })
    .limit(6);
  if (error || !data || data.length < 6) return;

  const [latest, ...previous] = data;
  const prevAvg = previous.reduce((a, r) => a + r.filler_word_count, 0) / previous.length;
  if (prevAvg <= 0 || latest.filler_word_count > prevAvg * 0.5) return;

  const { data: existing } = await supabaseAdmin
    .from('badges').select('id')
    .eq('user_id', userId).eq('badge_type', 'Filler Words Cut in Half').eq('session_id', latest.id);
  if (existing && existing.length > 0) return;

  await supabaseAdmin.from('badges').insert([{
    user_id: userId, badge_type: 'Filler Words Cut in Half', session_id: latest.id,
  }]);
}

async function checkFluencyClimbBadge(userId) {
  const { data, error } = await supabaseAdmin
    .from('session_results')
    .select('id, clarity, fluency, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(6);
  if (error || !data || data.length < 6) return;

  const [latest, ...previous] = data;
  const combo = (r) => (r.clarity + r.fluency) / 2;
  const prevAvg = previous.reduce((a, r) => a + combo(r), 0) / previous.length;
  if (combo(latest) < prevAvg + 1.5) return;

  const { data: existing } = await supabaseAdmin
    .from('badges').select('id')
    .eq('user_id', userId).eq('badge_type', 'Fluency Climb').eq('session_id', latest.id);
  if (existing && existing.length > 0) return;

  await supabaseAdmin.from('badges').insert([{
    user_id: userId, badge_type: 'Fluency Climb', session_id: latest.id,
  }]);
}

// ---------- Socket.io ----------
io.on('connection', (socket) => {
  // Socket.IO handed this socket back its previous id + socket.data after a
  // brief disconnect (see connectionStateRecovery above). If we'd started a
  // grace-period timer to eventually remove them, cancel it — they're back
  // before anyone else even needed to notice they were gone.
  if (socket.recovered && socket.data.roomCode) {
    const room = rooms[socket.data.roomCode];
    if (room && room.pendingDisconnects && room.pendingDisconnects[socket.id]) {
      clearTimeout(room.pendingDisconnects[socket.id]);
      delete room.pendingDisconnects[socket.id];
    }
  }

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
        hostUserId: dbRoom.created_by, topic: dbRoom.topic || null, teamMode: !!dbRoom.team_mode,
        members: {}, observers: new Set(), teams: {}, order: [], turnIndex: -1, memberInfo: {},
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
 const existingIds = Object.keys(room.members);
  socket.emit('existing-peers', existingIds.map(id => ({ id, name: room.members[id].name })));

   existingIds.forEach(memberId => {
    io.to(memberId).emit('observer-joined-peer', { id: socket.id });
  });

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
    room.memberInfo[socket.id] = { name: profile.name, userId: user.id };

    const existingIds = Object.keys(room.members).filter(id => id !== socket.id);
    socket.emit('existing-peers', existingIds.map(id => ({ id, name: room.members[id].name })));
    socket.to(roomCode).emit('peer-joined', { id: socket.id, name: profile.name });
    room.observers.forEach(obsId => {
  socket.emit('observer-joined-peer', { id: obsId });
});
    socket.emit('joined-info', { isHost: user.id === room.hostUserId });
    broadcastRoom(roomCode);
  });

  // Host-only, while the room is still waiting to start (Team Mode)
  socket.on('assign-team', ({ targetId, team }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || room.state !== 'waiting' || !room.teamMode) return;
    const me = room.members[socket.id];
    if (!me || me.userId !== room.hostUserId) return;
    if (!room.members[targetId]) return;
    if (team !== 'A' && team !== 'B' && team !== null) return;

    if (team === null) delete room.teams[targetId];
    else room.teams[targetId] = team;
    broadcastRoom(roomCode);
  });

  socket.on('randomize-teams', () => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    if (!room || room.state !== 'waiting' || !room.teamMode) return;
    const me = room.members[socket.id];
    if (!me || me.userId !== room.hostUserId) return;

    const ids = Object.keys(room.members).sort(() => Math.random() - 0.5);
    ids.forEach((id, i) => { room.teams[id] = i % 2 === 0 ? 'A' : 'B'; });
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

    uploadRecording(Buffer.from(buffer), `room-${roomCode}-${socket.id}`).then(url => {
      if (url) room.audioUrls = { ...(room.audioUrls || {}), [socket.id]: url };
    });

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
      // Observers don't hold a mic seat or affect turn order/scoring, so it's
      // safe to remove them right away — no grace period needed.
      room.observers.delete(socket.id);
      broadcastRoom(roomCode);
      return;
    }

    // Don't treat this as a real departure yet — it's very likely a brief
    // wifi drop, laptop sleep, or backgrounded tab, especially on a shared
    // classroom network. Give them DISCONNECT_GRACE_MS to reconnect (Socket.IO's
    // connectionStateRecovery will hand them back the same socket.id, which
    // cancels this timer up above in the 'connection' handler). Only if they
    // don't come back in time do we actually pull them out of the room.
    room.pendingDisconnects = room.pendingDisconnects || {};
    room.pendingDisconnects[socket.id] = setTimeout(() => {
      delete room.pendingDisconnects[socket.id];
      finalizeDeparture(roomCode, socket.id);
    }, DISCONNECT_GRACE_MS);
  });
});

// Actually removes a member who never reconnected after the grace period —
// this is the logic that used to run directly inside 'disconnect'.
function finalizeDeparture(roomCode, socketId) {
  const room = rooms[roomCode];
  if (!room) return;
  // They reconnected (with a new socket.id) and rejoined through some other
  // path in the meantime — nothing to clean up.
  if (room.members[socketId] === undefined && room.order.indexOf(socketId) === -1) return;

  const wasCurrentSpeaker = room.state === 'speaking' && room.order[room.turnIndex] === socketId;

  delete room.members[socketId];
  // They can no longer upload audio for a turn that was in flight, so drop
  // any pending-transcription entry for them — otherwise runRating() waits
  // forever for audio that will never arrive and the whole room gets stuck.
  room.pendingTranscriptions.delete(socketId);

  // Remove them from the speaking queue. If they hadn't spoken yet, this
  // just skips their slot. If it was already their turn, the next
  // speaker shifts into room.turnIndex automatically (array shrinks by one).
  const orderIdx = room.order.indexOf(socketId);
  if (orderIdx !== -1) {
    room.order.splice(orderIdx, 1);
    if (orderIdx < room.turnIndex) {
      room.turnIndex -= 1;
    }
  }

  io.to(roomCode).emit('peer-left', { id: socketId });

  if (Object.keys(room.members).length === 0 && room.observers.size === 0) {
    clearTimeout(room.timer);
    clearTimeout(room.peerTimer);
    delete rooms[roomCode];
    return;
  }

  if (wasCurrentSpeaker) {
    // Nobody can finish their turn for them — move on immediately instead
    // of leaving everyone staring at a "speaking" banner for someone who's
    // gone (and with no skip-turn owner left to dismiss it) for a full minute.
    clearTimeout(room.timer);
    beginTurnAtCurrentIndex(roomCode);
  } else if (room.state === 'peer-rating') {
    // If they were the only member still expected to submit ratings,
    // unblock the room instead of waiting out the full rating timer.
    const memberIds = Object.keys(room.members);
    const submittedIds = Object.keys(room.peerRatings);
    if (memberIds.length > 0 && memberIds.every(id => submittedIds.includes(id))) {
      finishPeerRating(roomCode);
    }
  } else if (room.state === 'rating' && room.pendingTranscriptions.size === 0) {
    // They were the last pending transcription — safe to score now.
    runRating(roomCode);
  }

  broadcastRoom(roomCode);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SpeakRate running on port ${PORT}`));