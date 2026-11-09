# Attendance System — Backend (Flask)

## Local dev (MySQL)

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python run.py
```

Runs on http://localhost:5000 against the MySQL named by `DATABASE_URL`
(default `mysql+pymysql://attendance:attendance-dev@127.0.0.1:3306/attendance`;
create it as shown in the top-level README). Older databases are upgraded in
place on startup (`app/schema_upgrade.py`).

Run the tests: `python -m pytest tests -q`. They use in-memory SQLite, except
`tests/test_mysql_integration.py`, which runs only when `TEST_MYSQL_URL` points
at a MySQL schema whose name ends in `_test` (it is dropped and recreated):

    TEST_MYSQL_URL=mysql+pymysql://root:PASSWORD@127.0.0.1:3306/attendance_test python -m pytest tests/test_mysql_integration.py

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
| `EARLY_GRACE_MINUTES` | `5` | minutes before scheduled end tolerated before flagging an early departure |
| `ATTENDANCE_COOLDOWN_SECONDS` | `60` | ignore repeat scans |
| `MIN_ENROLLMENT_SAMPLES` | `5` | poses needed to finish enrolling |
| `LIVENESS_REQUIRED` | `true` | require a blink |
| `ALLOW_PUBLIC_REGISTRATION` | `false` | self sign-up (off for companies) |
| `ENROLL_BLUR_THRESHOLD` | `45` | sharpness floor for enrollment samples (kiosk uses a looser one) |
| `FACE_MATCH_THRESHOLD` etc. | engine default (SFace `0.50`) | only override after testing |

## Main endpoints

| Method & path | Who | Purpose |
|---|---|---|
| `POST /api/users` | Admin | create employee (password optional for staff) |
| `GET/PATCH/DELETE /api/users/<id>` | Admin | manage employee |
| `GET /api/users/<id>/photo` | Admin/Operator or kiosk | face thumbnail |
| `POST /api/enrollment/sample` | Admin | add one face sample |
| `POST /api/recognition/check-in` | signed in | kiosk burst → status |
| `GET /api/reports/today` · `/daily` · `/export.csv` | Admin/Operator | dashboard, timesheets, CSV |
| `POST/PATCH/DELETE /api/attendance` | Admin | manual entries & corrections (audited) |
| `GET /api/reports/audit` | Admin | audit log |
