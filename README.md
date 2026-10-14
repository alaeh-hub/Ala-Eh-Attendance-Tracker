# Ala Eh! Facial Recognition Attendance System

Ala Eh! is a browser-based employee attendance application. An administrator manages employees and their face enrollment; an authenticated operator runs the kiosk; employees identify themselves at the kiosk to record attendance. The system includes live attendance views, time records, reporting, manual corrections, an audit log, and a review queue for uncertain scans.

This guide describes the implementation in this repository. The main components are a React/TypeScript frontend, a Flask API and recognition service, and either SQLite for local development or PostgreSQL for a deployed stack.

## Contents

- [System overview](#system-overview)
- [Recognition and scoring](#recognition-and-scoring)
- [Enrollment flow](#enrollment-flow)
- [Kiosk check-in flow](#kiosk-check-in-flow)
- [Attendance rules](#attendance-rules)
- [Application architecture](#application-architecture)
- [Data model](#data-model)
- [Authentication and data protection](#authentication-and-data-protection)
- [Run locally](#run-locally)
- [Run with Docker Compose](#run-with-docker-compose)
- [Configuration](#configuration)
- [API overview](#api-overview)
- [Operations, limitations, and tuning](#operations-limitations-and-tuning)
- [Repository map](#repository-map)

## System overview

```text
Browser (React kiosk or admin portal)
        │ HTTPS/HTTP JSON, multipart images, Socket.IO
        ▼
Flask API ── face engine (YuNet/SFace or dlib)
        │                     │
        │                     ├── face detection, quality, embeddings
        │                     ├── vectorized match and burst voting
        │                     ├── blink liveness and optional anti-spoof
        │                     └── in-memory embedding index
        ▼
SQL database (users, face samples, attendance, audit, scan snapshots)
```

The frontend is a single-page application. The kiosk sends camera frames to the API; detection, embedding, identity matching, liveness evaluation, and attendance decisions are performed by the backend. The browser is not trusted to choose an employee identity or to write a punch directly.

The application supports three roles:

| Role | Typical access |
|---|---|
| `ADMIN` | Employee and department management, enrollment, review queue, reports, audit, and attendance corrections |
| `OPERATOR` | Kiosk, dashboard, attendance records, and operational reports |
| `STAFF` | Their own records; staff may sign in only if an account password is configured |

Employee records do not require portal access. A staff account without a usable password can still be enrolled and recognized at the kiosk.

## Recognition and scoring

### Face engine selection

`FACE_ENGINE=auto` selects OpenCV YuNet + SFace when both model files are present under `backend/models`; otherwise it selects dlib. The engines produce vectors in different embedding spaces, so vectors from different engines are never compared. Every face sample stores its engine name, and matching filters to the currently active engine. Switching engines therefore requires re-enrollment of employees whose saved samples were created by the other engine.

| Engine | Detection and embedding | Default match threshold | Default ambiguity margin |
|---|---|---:|---:|
| SFace | YuNet detector + OpenCV SFace ONNX recognizer | `0.50` | `0.08` |
| dlib | HOG detector + dlib face-recognition embedding | `0.91` | `0.03` |

Both use normalized 128-dimensional vectors in this implementation. The SFace models are `face_detection_yunet_2023mar.onnx` and `face_recognition_sface_2021dec.onnx`. See [`backend/models/README.md`](backend/models/README.md) for model placement and optional anti-spoof model files.

### How a face embedding is produced

An embedding is a numeric representation of a detected and aligned face. It is not a name, a photo, or a probability. Similarity is computed between normalized embeddings; the result is an operational match score and must be interpreted with the engine's threshold and ambiguity rules.

For enrollment and recognition, the backend decodes and bounds the submitted image, detects a face, optionally applies CLAHE lighting normalization to the face crop, and asks the active recognition engine to generate the embedding. The result is normalized to unit length before storage or comparison. Enrollment may produce averaged variants (`ENROLL_NUM_JITTERS`, default `5`); kiosk embedding uses the engine's lighter setting (SFace uses original and mirrored variants; dlib uses one pass).

The database stores one encrypted-or-plain JSON vector per captured face sample. Several samples per employee represent different poses and camera variation. At match time these vectors are loaded into an in-memory `float32` matrix with one normalized centroid per employee. The index is rebuilt when first needed and invalidated after enrollment changes. Inactive employees and vectors from another engine are excluded.

### Per-employee score

For a normalized probe vector `q`, an employee with sample vectors `v₁ ... vₙ` receives:

```text
best_sample = max(vᵢ · q)
centroid    = normalize(mean(v₁ ... vₙ))
centroid_sim = centroid · q
score       = 0.70 × best_sample + 0.30 × centroid_sim
```

Because the vectors are unit length, the dot products are cosine similarities. The best sample lets a matching pose contribute strongly; the centroid term makes a single unusual sample less decisive. The scores are ranked across employees, and the top score is compared to the runner-up.

Example: if an employee's best sample similarity is `0.72` and their centroid similarity is `0.64`, the employee score is `0.70 × 0.72 + 0.30 × 0.64 = 0.696`. With SFace's default `0.50` threshold, the score clears the threshold, but it is only accepted if the runner-up is at least `0.08` lower and the burst voting rule also passes.

### Burst aggregation and decisions

The kiosk sends a short burst (normally around 8–10 JPEG frames; the server accepts at most 16). The backend processes it as follows:

1. Decode each valid frame. Detect the face on the first frame and track it in subsequent frames where possible; if tracking fails, detect again. A configured guide oval can reject faces outside the zone or ask the employee to move closer.
2. Collect eye landmark measurements for liveness and assess face size, sharpness, and brightness. Frames failing image quality are not embedded.
3. Rank acceptable frames by their quality score and embed at most `RECOGNITION_MAX_EMBED_FRAMES` (default `3`). The service may stop early after at least two embeddings produce a unanimous, high-margin match, or a clearly distant stranger result.
4. Normalize each embedding. The service averages the burst vectors, removes outliers when there are more than two vectors (using the engine's outlier similarity), and re-averages the retained vectors.
5. Match the averaged vector against the employee index. Separately match individual frame embeddings; enough individual votes must agree with the same employee (`RECOGNITION_MIN_VOTE_RATIO`, default `0.60`).
6. Return a structured outcome. A score below threshold but within the low-confidence band is `LOW_CONFIDENCE`; farther below is `NO_MATCH`. A top score whose gap to the runner-up is below the engine ambiguity margin is `AMBIGUOUS_MATCH`. Otherwise the identity is `MATCHED`, subject to the burst vote requirement.

The default low-confidence bands are `0.08` for SFace and `0.05` for dlib. The score does not by itself prove liveness or authorize attendance. The route continues through anti-spoofing, blink liveness, cooldown, and punch resolution before recording an event.

### Additional scan checks

- **Quality:** the detected face must be large enough, sufficiently sharp, and within a broad brightness range. Kiosk blur uses a looser threshold than enrollment. Enrollment defaults to `ENROLL_BLUR_THRESHOLD=45`; the quality function's normal blur floor is `25`.
- **Blink liveness:** eye aspect ratio (EAR) is computed for both eyes from facial landmarks. The pooled samples need at least four usable readings; both eyes must fall to at most 75% of their median baseline, the mean drop must reach `LIVENESS_EAR_BLINK_DELTA` (default `0.06`), and at least two readings must show open eyes (at least 90% of baseline). Readings for the same device and identified employee are pooled for up to `LIVENESS_WINDOW_SECONDS` (default `8`) across scans. A passed blink is consumed. Liveness is required by default.
- **Passive anti-spoof:** when MiniFASNet ONNX files are installed, the configured model score estimates whether a frame is a live face. `SPOOF_MODE=auto` enforces the model when available and otherwise logs the weaker texture heuristic without blocking. `off`, `log`, and `enforce` can be selected explicitly. The heuristic alone is not strong enough to reject scans in auto mode.
- **Enrollment consistency:** a new sample must resemble that employee's existing sample centroid. The index is also checked for a face already enrolled to another employee. Defaults are engine-specific.

## Enrollment flow

1. An administrator creates an employee record and opens the guided enrollment page.
2. The browser requests a readiness check while the person positions their face. This lightweight path checks face location, image quality, and rough pose; it does not generate an embedding or save an image.
3. The guided capture sequence asks for a set of frontal and turned/tilted poses. Pose measurements are relative to that employee's first frontal pose, avoiding a universal camera-angle assumption. The configured minimum defaults to five saved samples; the UI's guided sequence can capture additional poses up to the configured maximum (default twelve).
4. On each submitted capture, the backend verifies the employee is active and records biometric consent before the first sample is stored. It checks the face zone, quality, and embedding validity, then runs own-sample consistency and cross-employee duplicate checks.
5. An accepted sample is saved with pose label, quality score, and engine name. The best frontal capture is retained as the employee's profile thumbnail. The database transaction commits and the in-memory embedding index is invalidated.
6. Enrollment status reports sample count, required minimum, outdated samples from another engine, captured poses, average quality, photo presence, and consent state.

An administrator can reset an employee's samples or clear all face enrollments. Resetting enrollment removes the vectors and profile image; it does not delete the employee record or attendance history.

## Kiosk check-in flow

1. An `ADMIN` or `OPERATOR` signs in and opens `/kiosk`, or a dedicated `KIOSK` device account signs in and lands there directly. Opening the kiosk calls `/api/auth/kiosk/lock`: the server reissues the session as kiosk-locked, so it can only reach the recognition endpoints until someone unlocks it with their password (`KIOSK` accounts can never unlock; an admin signs the device out by deactivating the account). Check-in requires a kiosk-locked session. The kiosk obtains organization-local time and break settings from `/api/recognition/kiosk-config`; it does not rely on the tablet's local clock for attendance policy.
2. While idle, it can submit a small frame to `/api/recognition/presence`. This performs detection only: it does not identify, embed, store, or create an attendance event.
3. When a person is in the guide area, the kiosk captures a burst and submits `frames`, `device_id`, optional guide-zone coordinates, and optionally a selected session/punch hint to `/api/recognition/check-in`.
4. The backend recognizes the face, evaluates passive anti-spoofing, and checks blink liveness. A failed or uncertain attempt returns a status and reason; uncertain scans may be saved as review snapshots. Such responses do not create attendance events.
5. A live, matched, active employee is passed to attendance rules. A short cooldown blocks immediate duplicates. A re-scan in the verification window reassures the employee without creating another punch. A punch selection from the kiosk is only a hint; the server corrects it if it conflicts with the day's record or schedule.
6. A successful event is committed with match score, liveness result, device, session, and UTC timestamp. A snapshot may be associated with it, and a Socket.IO event updates connected dashboards.

Possible check-in outcomes include `NO_FACE`, `NO_MATCH`, `LOW_CONFIDENCE`, `AMBIGUOUS_MATCH`, `SPOOF_SUSPECTED`, `LIVENESS_FAILED`, `COOLDOWN`, `VERIFIED`, and `MATCHED`. The frontend also represents connection/request errors locally.

## Attendance rules

- Event timestamps are stored as naive UTC and serialized with a `Z`; organization-local time is used for day boundaries, shifts, reports, and displayed times. Set `ORG_TIMEZONE` for the deployment.
- Regular punches use an AM/PM in/out sequence. AM and PM share a regular sequence: the first regular punch is a clock-in and events alternate based on the last regular punch. The AM/PM label is selected relative to the configured lunch break, not strictly at noon.
- OT has its own clock-in/clock-out pair and is only recorded when explicitly selected at the kiosk.
- A configured shift end prevents regular clock-in after the shift is over; overtime should be selected explicitly. If someone returns after the break without having recorded an AM clock-out, the system can add an automatic AM clock-out at the break start before recording the PM clock-in.
- Each of the six session/type combinations is a once-per-day slot. Scanning again for a filled slot returns a verification response rather than writing a duplicate.
- The cooldown prevents rapid duplicate scans. The re-verification window (default `120` seconds) makes immediate confirmation scans non-writing. Production `.env.example` sets cooldown to `60` seconds, while the application code default is `3` seconds; deployments should set this explicitly.
- Punches belong to a **work day**: the date the employee's shift started. Day schedules roll over at midnight. Overnight schedules (end at or before start, e.g. `22:00`-`06:00`) start their work day `WORKDAY_ROLLOVER_BUFFER_HOURS` (default `6`) before the shift, so a `06:05` clock-out pairs with the previous evening's clock-in, and a break such as `02:00`-`03:00` falls inside the same work day. Reports group by work day.
- Rotating-shift departments match each clock-in to the shift whose start is nearest, within `SHIFT_MATCH_WINDOW_HOURS` (default `4`). No matching shift means no schedule applies and the punch is never late.
- Late and early-leave minutes, the scheduled start/end and the work day are stamped on each event when it is written, so editing a department later does not rewrite history. Rows from before this change are evaluated against the current schedule. Manual entries and corrections are re-stamped.
- Late status is based on the first regular clock-in of the work day, the matched schedule (department, rotating shift, or global default), and `LATE_GRACE_MINUTES`. Reports calculate worked intervals from clock-in/out pairs and subtract overlap with the break. OT hours are summarized separately.
- Admin-entered or corrected attendance bypasses kiosk matching rules and is audited. Staff record queries are restricted to the signed-in employee.

## Application architecture

### Frontend (`frontend/`)

React 18, TypeScript, Vite, React Router, Zustand, Axios, and Socket.IO Client. The UI has a dark theme with Tailwind CSS. Routes are guarded by role in `src/App.tsx`; API authorization is independently enforced by the backend.

| Page | Purpose |
|---|---|
| `/login` | Sign in and establish a browser session |
| `/kiosk` | Full-screen attendance capture for admin/operator |
| `/admin` | Dashboard with attendance metrics and live feed |
| `/admin/employees` | Employee profiles, status, and account management |
| `/admin/enroll` | Guided employee face enrollment |
| `/admin/departments` | Departments, schedules, shifts, roles, and break settings |
| `/admin/reports` | Attendance and hours reporting |
| `/admin/review` | Review unmatched/uncertain scan snapshots |
| `/records` | Attendance records; staff are limited to their own |

Camera frames are captured and downscaled to JPEG by `src/hooks/useCamera.ts`. `src/services/api.ts` attaches bearer access tokens, refreshes an expired access token once, and emits an auth-expired event when refresh fails. `src/utils/` contains kiosk locking, session selection, guide-zone, and search helpers.

### Backend (`backend/`)

Flask app creation and extension setup are in `app/__init__.py`. Blueprints under `app/api/` expose JSON/multipart routes. Recognition and image work can be offloaded to a worker thread so Socket.IO requests are not blocked. The implementation expects a single Gunicorn eventlet worker for its in-memory liveness pool, embedding cache, and Socket.IO session map; multi-worker deployment needs shared state/message infrastructure (for example Redis) and appropriate changes.

Core service modules:

- `app/services/face_service.py`: enrollment, face presence, burst recognition, and match aggregation.
- `app/services/embedding_index.py`: engine-filtered, active-user embedding matrix and centroid cache.
- `app/services/attendance_service.py`: session/punch resolution, cooldown, duplicate prevention, late checks, and event creation.
- `app/services/snapshot_service.py`: best-effort scan snapshots, unmatched-scan throttling, and retention cleanup.
- `app/services/auth_service.py`: account registration and password authentication.
- `app/services/accuracy_eval.py`: recognition evaluation utilities.
- `app/vision/`: detector/engine adapters, embeddings, image quality, pose, liveness, anti-spoofing, enhancement, and guide-zone logic.

Socket.IO handlers are registered in `app/sockets.py`. The API emits `attendance_event` to connected dashboard clients after a successful punch. Error handlers in `app/middleware/` return consistent JSON errors. Audit helpers record sensitive administrative operations.

## Data model

The SQLAlchemy models live in `backend/app/models/`.

| Table | What it stores |
|---|---|
| `users` | Employee profile, role, password hash, active state, department, biometric consent metadata, and profile thumbnail |
| `face_embeddings` | One row per face sample: user, JSON vector, pose, quality, engine identifier, and timestamp |
| `attendance_events` | Clock-in/out event, AM/PM/OT session, UTC time, match score/status, liveness result, device, and notes |
| `departments` | Department schedule, shift definitions, roles, and lunch break interval |
| `scan_snapshots` | Retained kiosk frame plus status, match/runner-up/spoof scores, candidate/employee references, and review resolution |
| `audit_logs` | Actor, action, target, details, and timestamp for administrative actions |

The app calls `db.create_all()` and applies the in-place compatibility updater in `app/schema_upgrade.py` at startup for convenience. Flask-Migrate is initialized for migrations; use a deliberate migration process for production schema changes rather than relying on startup table creation as the deployment workflow.

## Authentication and data protection

- Passwords are stored as bcrypt hashes. The short-lived JWT access token is held only in page memory; the refresh token is an `httpOnly` cookie protected by a CSRF double-submit header, so neither is readable from `localStorage`. Reloading the page restores the session from the cookie.
- Protected requests reload the user from the database. Each user has a `token_version`; changing the password, role, active state or sign-in access bumps it and revokes every existing session. Logout and kiosk lock add the old token to a blocklist (`revoked_tokens`).
- Roles: `ADMIN`, `OPERATOR`, `STAFF`, and `KIOSK` (a device account that can only run the kiosk). Role checks and the kiosk lock are enforced by backend route decorators; a kiosk-locked session gets `403 KIOSK_LOCKED` everywhere outside the kiosk endpoints.
- Login, refresh, kiosk unlock, password verification, check-in, presence and enrollment are rate limited (`429` with `Retry-After`), and an email is locked out after repeated failed logins. Limits live in process memory (single worker by design); `RATE_LIMITS_ENABLED=false` disables them.
- Deleting an employee who has attendance history archives them instead: the account is deactivated and its face data, photo and snapshots are erased, but attendance stays for payroll. Account and department changes are written to the audit log, which "clear all data" keeps.
- CORS origins are configured with `CORS_ORIGINS`. Production serves the app and API from one origin through Caddy, so this is normally just the site's `https://` address.
- `FACE_DATA_KEY` enables Fernet encryption at rest for face embeddings, profile thumbnails, and snapshots. Existing plaintext rows remain readable; `backend/tools/encrypt_existing_data.py` can migrate them. Without the key, new biometric data is stored without application-level encryption.
- In `APP_ENV=production`, startup refuses placeholder/weak Flask or JWT secrets, a missing/invalid biometric encryption key, or SQLite. Use unique secrets of at least 32 characters and back up `FACE_DATA_KEY`; encrypted biometric data cannot be recovered without it.
- Snapshots are enabled by default. Matched snapshots are retained for `SNAPSHOT_RETENTION_DAYS` (default `90`); other statuses use `SNAPSHOT_UNMATCHED_RETENTION_DAYS` (default `30`). Unmatched snapshots are throttled per device/status. Viewing or resolving review items is an administrative action.
- The API bounds request size and decoded image dimensions. CSV exports escape spreadsheet formula prefixes in user-controlled text.

## Run locally

Requirements: Python compatible with the pinned backend dependencies, Node.js/npm, and camera access from the browser. Local development defaults to SQLite and does not require Docker.

### Backend

```powershell
cd backend
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python seed_admin.py admin@example.com "Admin User"   # prompts for the password
python run.py
```

The API listens on `http://localhost:5000`. The default SQLite database is created under Flask's instance directory. Create the initial administrator once; do not use the example password outside a local machine.

### Frontend

In a second terminal:

```powershell
cd frontend
npm install
Copy-Item .env.example .env
npm run dev
```

The dev server proxies `/api` and `/socket.io` to `http://localhost:5000` (set `VITE_DEV_PROXY_TARGET` in `frontend/.env` to point elsewhere, e.g. a backend on another machine). Keep the app and API on one origin: the session cookie does not survive a reload cross-origin.

Open `http://localhost:5173`, sign in as the seeded administrator, create employees, record biometric consent, and enroll the required samples. Open the kiosk on a camera-equipped device to record attendance.

To use SFace, put the two YuNet/SFace ONNX files listed in [`backend/models/README.md`](backend/models/README.md) into `backend/models/`. Without them, `FACE_ENGINE=auto` uses dlib. SFace/dlib samples cannot be mixed for matching; changing the active engine requires re-enrollment.

## Run with Docker Compose

**Production:** follow [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). The stack is Caddy (HTTPS with automatic or internal certificates; the only service publishing ports), the built frontend on unprivileged nginx, the backend under gunicorn/eventlet as a non-root user, PostgreSQL, and a daily `pg_dump` backup service. Browsers only allow camera access over HTTPS (or `localhost`), so kiosks on a LAN need the HTTPS setup described there. Database migrations run automatically when the backend starts (`python manage_db.py upgrade`).

```powershell
python backend/tools/generate_secrets.py --write backend/.env   # then edit CORS_ORIGINS
Copy-Item deploy/env.example .env                               # SITE_ADDRESS, TLS_MODE
docker compose up -d --build
docker compose exec backend python seed_admin.py admin@example.com "Admin User"
```

**Development:** `docker compose -f docker-compose.dev.yml up --build` runs the Vite dev server with live reload on `http://localhost:5173`, the backend on `127.0.0.1:5000` and PostgreSQL on `127.0.0.1:5432`, with volumes separate from production.

Keep `.env` files and encryption keys out of source control, and back up `FACE_DATA_KEY` separately from the database backups. Schema changes ship as Alembic migrations in `backend/migrations/`; `python manage_db.py check` verifies that the models and migrations agree.

## Configuration

The backend reads `.env` / environment variables through `backend/config.py`. The following are the main operational settings; the source file contains the complete list.

| Variable | Default | Purpose |
|---|---|---|
| `APP_ENV` | `development` | `production` enables strict startup security checks |
| `DATABASE_URL` | SQLite `attendance.db` | SQLAlchemy database connection; use PostgreSQL in production |
| `SECRET_KEY`, `JWT_SECRET_KEY` | Development placeholders | Flask and JWT signing secrets; set unique strong values |
| `FACE_DATA_KEY` | unset | Fernet key for biometric data encryption at rest |
| `FACE_ENGINE` | `auto` | `sface`, `dlib`, or auto-select based on model files |
| `FACE_MATCH_THRESHOLD` | Engine default (`0.50` SFace, `0.91` dlib) | Minimum combined similarity score |
| `FACE_AMBIGUITY_MARGIN` | Engine default (`0.08` SFace, `0.03` dlib) | Required lead over the runner-up |
| `RECOGNITION_MAX_EMBED_FRAMES` | `3` | Maximum quality-ranked frames embedded per burst |
| `RECOGNITION_MIN_VOTE_RATIO` | `0.60` | Minimum individual-frame agreement ratio |
| `MIN_ENROLLMENT_SAMPLES` / `MAX_ENROLLMENT_SAMPLES` | `5` / `12` | Enrollment sample count limits |
| `ENROLL_BLUR_THRESHOLD` | `45` | Enrollment sharpness floor; kiosk uses a looser quality floor |
| `LIVENESS_REQUIRED` | `true` | Require a detected blink before recording attendance |
| `LIVENESS_EAR_BLINK_DELTA` / `LIVENESS_WINDOW_SECONDS` | `0.06` / `8` | Blink drop and cross-scan sample window |
| `SPOOF_MODE` | `auto` | `off`, `log`, `enforce`, or model-aware `auto` |
| `ORG_TIMEZONE` | `Asia/Manila` | Organization day/report timezone |
| `SHIFT_START` / `SHIFT_END` | `08:00` / `17:00` | Default schedule when department schedule is unavailable |
| `BREAK_START` / `BREAK_END` | `12:00` / `13:00` | Default break and AM/PM boundary |
| `LATE_GRACE_MINUTES` | `15` | Late-arrival grace period |
| `ATTENDANCE_COOLDOWN_SECONDS` | `3` in code | Minimum interval before another scan can write an event |
| `ATTENDANCE_REVERIFY_WINDOW_SECONDS` | `120` | Rescan window that only confirms the previous event |
| `CORS_ORIGINS` | Local Vite origins | Comma-separated browser origins allowed to call the API |
| `TRUST_PROXY_HOPS` | `0` | Reverse proxies in front of the backend (`1` behind Caddy); used for client IPs and same-origin checks |
| `JWT_COOKIE_SECURE` | `true` in production | Send the refresh cookie over HTTPS only |
| `KIOSK_REFRESH_DAYS` | `30` | How long a kiosk-locked or `KIOSK` device session stays signed in |
| `RATE_LIMITS_ENABLED` | `true` | In-memory rate limits and login lockout |
| `WORKDAY_ROLLOVER_BUFFER_HOURS` | `6` | How long before an overnight shift its work day starts |
| `SHIFT_MATCH_WINDOW_HOURS` | `4` | How far a clock-in may be from a rotating shift's start to match it |
| `LIVENESS_VERIFY_BLINK_FRAME` | `true` | Require the blink frame to match the recognized person |
| `SPOOF_CHECK_FRAMES` | `3` | Frames scored by passive anti-spoofing (the worst score counts) |

Threshold overrides are engine-dependent and should only be set after evaluation on representative local cameras and lighting. `backend/tools/evaluate_accuracy.py` evaluates thresholds; `backend/tools/encrypt_existing_data.py` encrypts existing biometric data; `backend/tools/migrate_to_postgres.py` supports moving a local database to PostgreSQL.

## API overview

All application endpoints are under `/api`; most require a bearer JWT. The backend remains the source of truth for authorization.

| Prefix | Main operations | Access pattern |
|---|---|---|
| `/auth` | register (when enabled), login, refresh (cookie), logout, current user, password verification, kiosk lock/unlock | Public login/refresh; other operations authenticated |
| `/users` | create/list/update/deactivate/delete employees, retrieve profile photo | Primarily admin; staff data is filtered where applicable |
| `/departments` | list/create/update/delete schedules, roles, shifts, and break settings | Admin management |
| `/enrollment` | pose sequence/status, readiness check, submit sample, reset samples | Admin |
| `/recognition` | kiosk config, presence detection, burst check-in | Kiosk; check-in requires a kiosk-locked admin/operator/`KIOSK` session |
| `/attendance` | list events, manual add/edit/delete | Staff sees own records; corrections are admin-only and audited |
| `/reports` | today, daily, hours summary/PDF, CSV, summary, audit | Admin/operator with admin-only reports as enforced per endpoint |
| `/review` | list/view snapshots, enroll reviewed frame, dismiss/delete | Admin |
| `/admin` | destructive system administration such as clearing all data | Admin |
| `/meta` | organization timezone and server time | Authenticated (kiosk allowed) |
| `/api/health` | database connectivity probe | Health check |

List endpoints for users, attendance and the audit log accept `limit`/`offset` and return the total in an `X-Total-Count` header. See route decorators and request validation in `backend/app/api/` for exact methods, fields, and role restrictions. Check-in accepts multipart `frames`; each entry is an image file.

## Operations, limitations, and tuning

- Recognition thresholds are starting operating points, not a guarantee of payroll-grade accuracy. Run the included evaluator and a real pilot with the target cameras, distances, employee population, and lighting before operational reliance. Do not tune a threshold from a few successful scans alone.
- Blink detection rejects still photos and many frozen-image attempts, but a replayed video containing a blink can pass. Liveness is bound to identity: only frames from the same continuous face track as the recognized face count, and the closed-eye frame itself must match the recognized person, so a held-up photo cannot borrow a live person's blink. The default eye-landmark model (dlib 68-point, trained on iBUG 300-W) has non-commercial licence terms; review them before commercial use (`LIVENESS_LANDMARK_MODEL` selects the source). MiniFASNet adds passive anti-spoofing when installed; even then, validate representative attacks and genuine-user rejection locally.
- The built-in texture heuristic is only a weak signal. In auto mode it is log-only and does not reject users without a MiniFASNet model.
- Recognition is limited to the currently active engine's samples. If model availability changes such that auto-selection changes engines, old samples will be marked outdated and require re-enrollment.
- Liveness samples and the embedding index are process memory. The run configuration expects one backend worker; multi-worker deployments need shared state or sticky/central coordination. Socket.IO scaling also needs a message queue.
- Keep PostgreSQL backups, biometric encryption keys, and model files protected. Define retention and access procedures for face samples and snapshots in line with the organization's privacy requirements.
- Tests: `cd backend; .venv\Scripts\python -m pytest tests -q` and `cd frontend; npm test`. CI (`.github/workflows/ci.yml`) also type-checks, builds both images and checks the migrations against PostgreSQL.

## Repository map

```text
backend/
  app/api/          Flask route blueprints
  app/models/       SQLAlchemy data models
  app/services/     Recognition, enrollment, attendance, auth, and snapshots
  app/vision/       Face engines, quality, pose, liveness, anti-spoof
  app/utils/        Auth, crypto, audit, timezone, validation, and threading
  tests/            Backend behavior and integration tests
  tools/            Evaluation, migration, and secret/data utilities
  run.py            Development and WSGI app entry point
frontend/
  src/pages/        Kiosk and administrative pages
  src/components/   Shared shells, camera, UI, and dialogs
  src/services/     HTTP API client
  src/stores/       Authentication and toast state
  src/hooks/        Camera and interaction hooks
docker-compose.yml  PostgreSQL + backend + frontend development stack
```
