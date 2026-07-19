# SpeakRate 🎙️

Students join a voice room (up to 8 people), take turns speaking, and an AI rates every speaker at the end and picks the "best speaker."

## How it works
- **Voice**: real peer-to-peer audio (WebRTC) between everyone in the room — no paid media server needed.
- **Turns**: when the host clicks "Start Session," the server picks a random speaking order and gives each person 60 seconds.
- **Transcription**: each speaker's browser transcribes their own turn live (Chrome's built-in Speech Recognition — free, no API calls).
- **Rating**: once everyone has spoken, the server sends all transcripts to Claude, which scores each speaker (clarity, fluency, structure, vocabulary, confidence) and picks the best speaker.

## 1. Run it locally

Requirements: Node.js 18+, and an Anthropic API key (get one free at console.anthropic.com — new accounts get starter credit).

```bash
cd speakrate
npm install
cp .env.example .env
# edit .env and paste your ANTHROPIC_API_KEY
npm start
```

Open `http://localhost:3000` in **two or more browser tabs** (or on two devices), use the same room code, and try it out. Use Chrome — Speech Recognition doesn't work in Firefox/Safari yet.

## 2. Deploy it for free

**Render.com (recommended, free web service tier):**
1. Push this folder to a GitHub repo.
2. Go to render.com → New → Web Service → connect your repo.
3. Build command: `npm install` — Start command: `npm start`.
4. Add an environment variable: `ANTHROPIC_API_KEY` = your key.
5. Deploy. Render gives you a free `https://yourapp.onrender.com` URL — WebRTC needs HTTPS, and Render provides it automatically.

*(Railway.app and Fly.io work the same way if you prefer them — free tiers on both.)*

## 3. Cost reality-check
- Hosting: $0 on Render's free tier (it sleeps after inactivity on the free plan; fine for a student project, upgrade later if you get real traffic).
- Voice: $0 — WebRTC is peer-to-peer, browser to browser.
- AI rating: a few cents per session via the Claude API (only called once, at the end, on text — not audio). Anthropic gives new accounts starter credit.

## Known limitations to plan around (this is a solid MVP, not v1.0)
- **8-way mesh WebRTC** works well for a classroom-scale MVP, but audio quality/CPU load degrades as you scale up rooms or add video later. If you outgrow it, swap in an SFU like LiveKit (also free/open-source, self-hostable).
- **Speech Recognition** is Chrome-only and needs a decent mic/quiet room — this is a browser limitation, not something we can fix client-side.
- **No accounts/history yet** — right now it's session-only. Natural next step: add login (e.g. Google OAuth) + a database (Supabase's free tier is a good fit) to track students' scores over time.
- **No moderation** — anyone with the room code can join. Fine for a class link shared by a teacher; add a "host approves joiners" step before wider release.

## File structure
```
speakrate/
  server.js          # signaling, room/turn logic, AI rating call
  public/
    index.html
    style.css
    app.js            # WebRTC mesh, mic, speech recognition, UI
  package.json
  .env.example
```