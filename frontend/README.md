# Attendance System — Frontend (React + Vite + TypeScript)

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

Runs on http://localhost:5173. Dark black & yellow theme (Tailwind tokens
`ink-*` and `brand-*` in `tailwind.config.js`); the logo is `public/logo.png`.

| Page | Roles | Notes |
|---|---|---|
| Dashboard | Admin, Operator | live stats, hourly chart, live feed (Socket.IO) |
| Kiosk | Admin, Operator | auto-scan loop, blink prompt, fullscreen mode, chime |
| Enroll | Admin | 3-step wizard: details → guided 6-pose auto-capture → summary |
| Employees | Admin | search/filter, edit, reset password, deactivate, delete |
| Records | all | timesheet, scan log, CSV export, manual entries (staff see only their own) |

Camera frames are downscaled to 640px JPEGs before upload
(`src/hooks/useCamera.ts`). Expired access tokens are refreshed
automatically (`src/services/api.ts`).
