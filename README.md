# SpeakRate 🎙️ — Phase 1

Students sign in, join voice rooms (up to 8 people), speak in turns, get rated by
AI + their peers, and results are saved to their account history.

## What's in Phase 1
- **Auth**: Supabase email/password sign up & sign in, `student`/`admin` roles
- **Dashboard**: sidebar with Create Room, Join Room, Leaderboard (placeholder),
  My History (placeholder), Admin-only Live Rooms
- **Rooms**: create with a name + optional password; join by code; admins bypass
  passwords
- **Admin Observer Mode**: admins can silently watch any live room without
  taking a mic seat
- **Peer rating**: after everyone speaks, each participant rates every other
  participant 1-5 stars; final score = 60% AI score + 40% peer average
- **Persistence**: every completed session is saved to Supabase
  (`session_results` table) — foundation for Phase 2's Leaderboard/History pages

## 1. Set up Supabase (free)

1. Go to supabase.com → New Project (free tier)
2. Once created, go to **SQL Editor** → New Query → paste the entire contents
   of `supabase-schema.sql` (included in this project) → Run
3. Go to **Settings → API** and copy three values:
   - Project URL → `SUPABASE_URL`
   - `anon` `public` key → `SUPABASE_ANON_KEY`
   - `service_role` key (⚠️ keep secret, never expose to the browser) → `SUPABASE_SERVICE_ROLE_KEY`

### Making yourself an admin
By default every sign-up is a `student`. To make an account an admin, run this
in Supabase's SQL Editor after signing up once:
```sql
update profiles set role = 'admin' where id = (select id from auth.users where email = 'your@email.com');
```

## 2. Run it locally

```bash
npm install
cp .env.example .env
# fill in GROQ_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
npm start
```

Open `http://localhost:3000` — it'll route you to sign up / sign in, then the
dashboard. Use Chrome. Test with two accounts in two tabs (or incognito for the
second) to try a room with 2+ people.

## 3. Deploy (Render, free tier)

Same as before — push to GitHub, connect the repo on Render.com, build command
`npm install`, start command `npm start`, and add ALL FIVE env vars
(`GROQ_API_KEY`, `GROQ_MODEL`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
`SUPABASE_SERVICE_ROLE_KEY`) in Render's Environment tab.

## File structure
```
speakrate/
  server.js              # auth, rooms, signaling, peer rating, AI rating, persistence
  supabase-schema.sql     # run this in Supabase SQL Editor once
  package.json
  .env.example
  public/
    index.html            # auth-aware redirect (login or dashboard)
    login.html / auth.js   # sign in / sign up
    dashboard.html / dashboard.js   # sidebar shell, create/join room, admin room list
    room.html / room.js    # the actual voice room (WebRTC, recording, peer rating, results)
    style.css
```

## Known limitations (still true from the MVP, plus new ones)
- 8-way mesh WebRTC — fine for classroom scale, revisit if you scale up rooms
- Peer rating waits up to 30 seconds for everyone to submit, then proceeds with
  whoever did
- Leaderboard and My History pages are placeholders — that's Phase 2
- No email confirmation flow handling beyond Supabase's default (check your
  Supabase Auth settings if sign-ups aren't working — email confirmation may be
  required depending on your project settings)