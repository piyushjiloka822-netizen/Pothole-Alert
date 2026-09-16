# Pothole Grievance Portal — Municipal Corporation of Lucknow (prototype)

A static, no-build citizen pothole-reporting portal + an admin/officer dashboard.
Live demo: https://pothole-application.vercel.app/

> ⚠️ **This is an unofficial student/portfolio prototype.** It is styled to
> look like an official Government of Uttar Pradesh e-governance portal for
> design-practice purposes, but it is **not affiliated with or endorsed by
> the Municipal Corporation of Lucknow or the Government of Uttar Pradesh.**
> Do not present it as a real government service.

## Stack

Plain HTML/CSS/JS — no framework, no build step. Deployable as a static site
anywhere (currently on Vercel). One optional serverless function (`/api`)
adds an AI photo-verification tier when an API key is configured.

- **Map:** Leaflet.js (OpenStreetMap tiles) + Leaflet.heat for the density heatmap
- **Charts (admin):** Chart.js
- **Data:** browser `localStorage` (see [Architecture note](#architecture-note--why-localstorage) below)
- **AI check:** client-side heuristics always on; server-side Gemini vision
  check via `/api/verify-pothole` (Vercel Serverless Function) if
  `GEMINI_API_KEY` is set

## Features

**Citizen portal (`index.html`)**
- GPS or tap-to-pin location on an interactive Leaflet map
- Live in-app camera capture *or* file upload for photo evidence
- Two-tier photo check (non-blocking): instant blur/brightness/flatness
  heuristics, plus an optional AI vision check if configured
- Real geo-duplicate detection (Haversine distance, 60 m radius) with an
  "upvote existing report instead" flow
- Severity, road type, zone, description, rate-limited submission
- Ticket tracking, community feed, upvotes, notifications, offline queue
  (reports made while offline are queued in `localStorage` and flushed on
  reconnect)
- Auto-escalation flag on reports pending 30+ days
- Pin view **or** severity-weighted heatmap toggle on the map
- Multilingual UI strings (`js/i18n.js`), accessibility toolbar

**Admin/officer portal (`admin.html`)**
- Hashed-password login (SHA-256, session timeout, login-attempt lockout — see `js/security.js`)
- Kanban-style status board (pending → scheduled → in-progress → resolved)
- Analytics: complaints by zone, severity, road type, and monthly trend (Chart.js)
- Escalated-report queue

## AI photo verification

`js/ai-verify.js` runs two tiers, both **non-blocking** — a warning never
silently rejects a citizen's report:

1. **Client-side heuristics** (always on, no network call): flags photos
   that are too dark/overexposed, near-blank/flat-color, or blurry.
2. **Server-side AI check** (optional): `POST /api/verify-pothole` sends the
   compressed photo to Google's **Gemini** vision model and asks "does this
   actually show a pothole/road damage?", returning a confidence score and
   a one-line reason.

To enable tier 2:
1. Get an API key at https://aistudio.google.com/app/apikey
2. **Local dev:** fill in `.env` (already gitignored — see `.gitignore`).
   Run `vercel dev` to test it.
3. **Production (Vercel):** Project → Settings → Environment Variables →
   add `GEMINI_API_KEY` there — **not** in any file that gets committed.
4. Redeploy. No frontend changes needed — the endpoint is auto-detected; if
   it's missing or unconfigured the UI just shows the heuristic-only result.

> ⚠️ **If a Gemini key was ever pasted into a chat, email, or anywhere
> outside Vercel's Environment Variables UI, treat it as compromised** —
> regenerate it at https://aistudio.google.com/app/apikey before relying
> on it for anything real.

See `.env.example`.

## Quick Report — photo + live location, no form

Alongside the full complaint form, the nav bar now has a **⚡ Quick Report**
button (`App.quickReport()` in `js/app.js`) for citizens who just want to
snap evidence fast:

1. Tap it → the live camera opens (falls back to the file picker if the
   camera API/permission isn't available).
2. Snap/select a photo → the browser's GPS (`navigator.geolocation`) is
   read automatically.
3. The report is submitted immediately — no description, severity, or
   address fields required (sensible defaults fill in: medium severity,
   "city-road", and the raw GPS coordinates as the address). It still runs
   through the same duplicate-detection, rate-limiting, and AI/heuristic
   photo check as the full form.
4. At the same moment, a small real-time ping goes to Firestore's
   `live_captures` collection via `CloudSync.pushLiveCapture`. Any admin
   dashboard open at that moment shows a **"📷 New photo captured from
   this location"** flash top-right for ~2 seconds, then it auto-dismisses
   (`AdminApp.showLiveCaptureFlash` in `js/admin.js`, styled in
   `css/admin.css`). This needs the shared database below to be
   configured — without it, Quick Report still works and saves locally,
   there's just no one to flash the ping to.

## Shared database (citizen ↔ admin sync)

As of this update, the app supports a real shared database via **Firebase
Firestore**, wired through two new files:

- `js/firebase-config.js` — paste your Firebase project's web config here
- `js/cloud-sync.js` — keeps a live Firestore `reports` collection mirrored
  into `localStorage`, and pushes every `Storage.saveReport` /
  `updateReport` / `deleteReport` call up to Firestore too

**Until you configure it, nothing changes** — `js/firebase-config.js` ships
with placeholder keys, `CloudSync.init()` detects that and no-ops, and the
app behaves exactly like the original localStorage-only prototype (each
browser keeps its own data).

**To turn on real cross-device sync** (citizen submits on their phone →
admin sees it on the dashboard, from anywhere):
1. Create a free Firebase project at https://console.firebase.google.com/
2. Enable **Firestore Database** (test mode is fine for a prototype)
3. Project settings → add a Web app → copy the `firebaseConfig` object
4. Paste those values into `js/firebase-config.js`
5. (Recommended) set the Firestore security rules shown in the comments at
   the top of `js/firebase-config.js`
6. Redeploy — no other code changes needed. `app.js` and `admin.js` still
   just call `Storage.*` synchronously; the sync happens transparently
   underneath and both pages re-render automatically on `cloud-reports-updated`.

This keeps the project a zero-backend static site — no server to write or
host, just a static Firestore config — while giving citizen and admin
portals a real shared database instead of separate per-browser copies.

Notifications are synced too: when an officer changes a report's status on
the admin dashboard, `Storage.addNotification` used to only ever write to
the *admin's own* browser storage, so the citizen who filed the report —
on a different device — would never actually see it. That's now mirrored
through a `notifications` Firestore collection the same way, so status
updates genuinely reach the citizen who filed the report.

If you'd rather use Supabase/Postgres instead, the same seam works: replace
the Firestore calls inside `js/cloud-sync.js` with your client of choice;
`storage.js` and the rest of the app don't need to change.

## Pushing to GitHub

If `git push -u origin main` fails with `error: src refspec main does not
match any` / `error: failed to push some refs`, it means there's no commit
yet on your local `main` branch (a bare/empty repo, or you're on a
differently-named branch). Fix:

```
git add -A
git commit -m "Update pothole application"
git branch -M main
git push -u origin main
```

Then in Vercel, redeploy (or it will auto-deploy on push if the GitHub repo
is already connected as the project's source).

## Local development

No build step — just serve the folder statically, e.g.:

```
npx serve .
```

Open `index.html` for the citizen portal, `admin.html` for the officer
dashboard (default password: see `Security.ADMIN_PASSWORD_HASH` in
`js/security.js` — change this before any real deployment).

To test the `/api/verify-pothole` serverless function locally, use the
[Vercel CLI](https://vercel.com/docs/cli): `vercel dev`.

## Known gaps / roadmap

- Shared database is opt-in (see above) — without Firebase configured it's
  still per-browser localStorage
- No real SMS/email/push notifications (in-app only, per-browser)
- No jurisdiction auto-routing to a specific officer, and no route-hazard
  navigation feature
- No citizen gamification/badge scoring
- OTP/Aadhaar login on `login.html` is a UI mock, not wired to a real
  identity provider
