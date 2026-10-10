# Attendance System — Backend (Flask)

## Local dev (SQLite, no Docker)

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python run.py
```

Runs on http://localhost:5000 using `instance/attendance.db`. Older
databases are upgraded in place on startup (`app/schema_upgrade.py`).

Run the tests: `python -m unittest tests.test_recognition_routes`

## Architecture

- **`app/vision/engines.py`** — pluggable face engines (`sface` default,
  `dlib` fallback): detection, tracking, embedding and each engine's
  calibrated thresholds. Every stored sample records its engine
  (`FaceEmbedding.model`); only the active engine's samples are matched.
- **`app/vision/liveness.py`** — blink liveness (both-eye EAR dip) with a
  per-device pool across consecutive scans.
- **`app/services/embedding_index.py`** — in-memory matrix of all active
  employees' embeddings, rebuilt only when enrollment/activation changes.
- **`app/services/face_service.py`** — enrollment pipeline (quality gate,
  consistency + duplicate-face checks, profile photo) and burst recognition
  (sharpest frames, early exit, averaging, voting).
- **`app/services/attendance_service.py`** — clock in/out per org-local day,
  cooldown, late detection. Timestamps are stored as UTC.
- **`app/api/`** — thin routes. Enrollment is admin-only (prevents buddy
  punching); check-in requires a signed-in kiosk; Socket.IO requires a JWT.

## Key settings (`.env` or environment)

| Variable | Default | Meaning |
|---|---|---|
| `FACE_ENGINE` | `auto` | `sface` if `models/*.onnx` exist, else `dlib` |
| `ORG_TIMEZONE` | `Asia/Manila` | defines "today" and report times |
| `SHIFT_START` / `LATE_GRACE_MINUTES` | `08:00` / `15` | late arrival rule |
| `ATTENDANCE_COOLDOWN_SECONDS` | `60` | ignore repeat scans |
| `MIN_ENROLLMENT_SAMPLES` | `5` | poses needed to finish enrolling |
| `LIVENESS_REQUIRED` | `true` | require a blink |
| `ALLOW_PUBLIC_REGISTRATION` | `false` | self sign-up (off for companies) |
| `FACE_MATCH_THRESHOLD` etc. | engine default | only override after testing |

## Main endpoints

| Method & path | Who | Purpose |
|---|---|---|
| `POST /api/users` | Admin | create employee (password optional for staff) |
| `GET/PATCH/DELETE /api/users/<id>` | Admin | manage employee |
| `GET /api/users/<id>/photo` | signed in | face thumbnail |
| `POST /api/enrollment/sample` | Admin | add one face sample |
| `POST /api/recognition/check-in` | signed in | kiosk burst → status |
| `GET /api/reports/today` · `/daily` · `/export.csv` | Admin/Operator | dashboard, timesheets, CSV |
| `POST/PATCH/DELETE /api/attendance` | Admin | manual entries & corrections (audited) |
| `GET /api/reports/audit` | Admin | audit log |
