# Ala Eh! — Facial-Recognition Attendance System

React + Vite + TypeScript frontend (black & yellow dark theme), Flask
backend. Employees are enrolled by an admin (details + guided face
capture) and clock in/out hands-free at a kiosk with face matching and
blink liveness. Live dashboard, timesheets, CSV export and an audit log.

## Quick start (local dev, SQLite)

```powershell
# Backend
cd backend
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python seed_admin.py admin@example.com "Admin User" changeme123   # first run only
python run.py                                                      # http://localhost:5000

# Frontend (separate terminal)
cd frontend
npm install
Copy-Item .env.example .env
npm run dev                                                        # http://localhost:5173
```

Sign in as the admin, then:

1. **Enroll** → fill in the employee's details → guided face capture (6 poses, auto-capture).
2. **Kiosk** → leave it open (fullscreen) on the entrance PC; employees look at the camera and blink.
3. **Dashboard / Records** → live attendance, timesheets, late arrivals, CSV export.

## How recognition works

| Step | What happens |
|---|---|
| Detection | OpenCV **YuNet** on a 320px copy of each frame; after the first frame the face is *tracked* in a small crop |
| Embedding | OpenCV **SFace** 128-d embedding (99.60% LFW), ~13 ms on CPU. Only the sharpest 2–3 frames of a burst are embedded, stopping early once two agree |
| Matching | All enrolled vectors are cached in one in-memory matrix; per-employee score = 0.7 × best sample + 0.3 × centroid. Averaged burst embedding + per-frame voting must agree |
| Decision | `MATCHED` / `LOW_CONFIDENCE` / `AMBIGUOUS_MATCH` / `NO_MATCH` with calibrated thresholds (`app/vision/engines.py`) |
| Liveness | Both eyes must close together (Eye Aspect Ratio ≤ 75% of baseline) with open frames around it; samples pooled across scans for 8 s |
| Enrollment guards | Rejects a sample that doesn't match the employee's earlier samples, and a face already enrolled as someone else |

Measured on this machine: a kiosk scan (8 frames) is **~0.3–0.5 s** server
time; a still photo of an enrolled employee is recognised but **blocked by
liveness**.

## Honest limits

- Blink liveness stops printed photos and frozen screens, **not** a replayed
  video of the employee blinking. For high-security sites add a dedicated
  anti-spoofing model behind `evaluate_blink()` in `app/vision/liveness.py`.
- Thresholds are calibrated from public sample photos. Run a pilot with your
  own cameras and lighting before relying on it for payroll.
- Employees enrolled before the SFace upgrade show **"Re-enrollment needed"**
  on the Enroll page — clear and re-capture them once.

See `backend/README.md` for architecture and configuration.
