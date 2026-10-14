# Deployment and operations

How to run the attendance system in production: one server running Docker,
kiosk tablets and admin PCs reaching it over HTTPS.

```
 kiosk tablets / admin PCs
          │  HTTPS (443, HTTP/3 on 443/udp; port 80 only redirects)
          ▼
 ┌──────────────── docker compose ─────────────────────────────────────┐
 │ caddy      TLS, security headers, compression                       │
 │   ├─ /api/*, /socket.io/*  ──► backend:5000  gunicorn + eventlet    │
 │   │                                 │         (1 worker, non-root)  │
 │   └─ everything else       ──► frontend:8080 nginx, static SPA      │
 │                                     ▼                               │
 │                                   db:5432    PostgreSQL 16          │
 │                                     ▲        (internal network)     │
 │                                   backup     pg_dump daily → ./backups
 └─────────────────────────────────────────────────────────────────────┘
```

Only Caddy publishes ports. The app, the API and the live feed are a single
origin, so the refresh cookie (httpOnly, `SameSite=Strict`, `Secure`) works
without any cross-origin setup.

**Why HTTPS is not optional:** browsers only give a web page camera access
(`getUserMedia`) on `https://` or `localhost`. A kiosk opening
`http://192.168.x.x` gets no camera at all.

Files involved:

| File | Purpose |
|---|---|
| `docker-compose.yml` | production stack |
| `docker-compose.dev.yml` | local development stack (hot reload, no TLS) |
| `.env` (repo root, from `deploy/env.example`) | `SITE_ADDRESS`, `TLS_MODE`, backup settings |
| `backend/.env` (from `backend/.env.example`) | app settings and secrets |
| `deploy/Caddyfile` | edge proxy, TLS, headers, CSP |
| `deploy/backup.sh`, `deploy/restore.sh` | database backup / restore |
| `backend/docker-entrypoint.sh` | waits for the DB, runs migrations, starts gunicorn |
| `frontend/nginx.conf` | static file server for the built SPA |

---

## 1. Server

- **OS:** any 64-bit Linux with Docker Engine 24+ and the Compose plugin
  (v2.24+). Windows/macOS with Docker Desktop also work for small sites.
- **Size:** 2 vCPU / 4 GB RAM / 20 GB disk handles a few hundred employees
  and several kiosks. A scan costs roughly 0.3 s of CPU on one core.
  **Building** the backend image compiles dlib and needs ~4 GB of free RAM
  the first time (about 15–30 minutes); later builds reuse the cache.
- **Disk:** the database holds encrypted face templates, profile photos and
  scan snapshots (kept 90/30 days by default). Plan ~50 MB per 1,000
  snapshots plus backups (14 daily dumps by default).
- **Network:** a fixed LAN IP (DHCP reservation) or a DNS name. Open
  TCP 80 and 443 and UDP 443 in the server firewall. Nothing else.
- **Clock:** keep NTP on. Attendance times come from the server clock; the
  org timezone is `ORG_TIMEZONE`, independent of the server's timezone.

## 2. Choose an address and TLS mode

Copy the compose settings file and edit it:

```sh
cp deploy/env.example .env
```

| Situation | `SITE_ADDRESS` | `TLS_MODE` |
|---|---|---|
| Public DNS name pointing at the server, ports 80/443 reachable from the internet | `attendance.example.com` | `acme` (automatic Let's Encrypt/ZeroSSL certificate, HSTS enabled) |
| LAN only, with a local DNS name | `attendance.lan` | `internal` (Caddy's own CA; install its root on every device, see §7) |
| LAN only, no DNS | `192.168.1.50` | `internal` |
| Company PKI / purchased certificate | the name on the cert | `files`: put `cert.pem` (full chain) and `key.pem` in `deploy/certs/` |
| Trying it on one machine | `localhost` | `internal` |

Several addresses can be listed: `SITE_ADDRESS=attendance.lan, 192.168.1.50`.

HSTS is only sent in `acme` mode, because a browser that has seen HSTS for a
name refuses to load it with a certificate warning ever again.

## 3. Secrets and app settings

Generate the secrets (any machine with Python 3 and `cryptography`, or the
backend venv):

```sh
python backend/tools/generate_secrets.py --write backend/.env
chmod 600 backend/.env
```

This writes `SECRET_KEY`, `JWT_SECRET_KEY`, `FACE_DATA_KEY`,
`POSTGRES_PASSWORD` and a matching `DATABASE_URL`. Then open `backend/.env`
and compare it with `backend/.env.example`; at least set:

- `CORS_ORIGINS` — the address(es) people type, with `https://`,
  e.g. `https://attendance.example.com` or
  `https://attendance.lan,https://192.168.1.50`. The app and API share one
  origin through Caddy, and the dashboard's live feed always accepts the
  site's own address (with `TRUST_PROXY_HOPS=1`), so this list only
  matters for additional origins; keeping it accurate is still good practice.
- `ORG_TIMEZONE`, `SHIFT_START`, `SHIFT_END`, `LATE_GRACE_MINUTES`,
  `BREAK_START`, `BREAK_END`.
- Retention: `SNAPSHOT_RETENTION_DAYS`, `SNAPSHOT_UNMATCHED_RETENTION_DAYS`
  (match your privacy notice).

Compose already sets `APP_ENV=production` and `TRUST_PROXY_HOPS=1` for the
backend. With `APP_ENV=production` the backend **refuses to start** with
placeholder or short secrets, without a valid `FACE_DATA_KEY`, or on
SQLite (`app/config_check.py`) — read `docker compose logs backend` if it
keeps restarting.

> **Back up `FACE_DATA_KEY` now**, somewhere other than this server and
> other than the database backups (password manager, sealed envelope in a
> safe). Face templates, photos and snapshots are encrypted with it. Without
> it, every backup's biometric data is unrecoverable and every employee has
> to be re-enrolled. Keep copies of both `.env` files the same way.

## 4. Face models

`backend/models/` is mounted read-only into the backend. It must contain the
YuNet and SFace ONNX files (see `backend/models/README.md` for download
links). Optionally add the MiniFASNet anti-spoofing models there too —
recommended for production; with `SPOOF_MODE=auto` they switch passive
anti-spoofing to enforcing.

## 5. Start

```sh
docker compose up -d --build
docker compose ps          # all services "healthy" / "running" after ~1-2 min
curl -k https://localhost/api/health     # {"database":"ok","ok":true}
```

On start the backend container waits for PostgreSQL, applies database
migrations (`python manage_db.py upgrade`), then starts
`gunicorn -k eventlet -w 1`. A database created by an older version of the
app (before migrations existed) is adopted automatically.

### First administrator

```sh
docker compose exec backend python seed_admin.py admin@example.com "Admin Name"
```

It prompts for the password (8-72 characters), so it stays out of shell
history. Sign in at `https://SITE_ADDRESS/`.

### Kiosk device accounts

Each kiosk tablet signs in with its own **Kiosk device** account rather than
a person's account:

1. Admin → **Enroll** → role **Kiosk device**, give it an email-style login
   (e.g. `kiosk-lobby@yourcompany.local`) and a strong password.
2. On the tablet, open `https://SITE_ADDRESS/`, sign in with that account.
   It goes straight to the kiosk screen and can never leave it: a kiosk
   session can only scan faces. Its sign-in lasts `KIOSK_REFRESH_DAYS`
   (default 30); after that, sign the tablet in again.
3. The device name recorded on each punch is the kiosk account
   (`kiosk:<employee code or email>`), so use one account per physical kiosk.

To retire or replace a tablet, deactivate its account (Admin → Employees);
its session is revoked immediately.

### Moving data from a development install

- SQLite → PostgreSQL: `tools/migrate_to_postgres.py --source sqlite:///... --target postgresql+psycopg2://...`
  (run against an empty database, before real use).
- Data recorded before `FACE_DATA_KEY` was set:
  `docker compose exec backend python tools/encrypt_existing_data.py`
  (back up first).

## 6. Kiosk tablet setup

Requirements: a front camera, a current Chromium-based browser (Chrome,
Edge) or Safari, HTTPS that the device trusts (no certificate warning), and
camera permission granted for the site.

**Windows (Chrome or Edge)**

```bat
"C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --app=https://attendance.lan/ --no-first-run
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --kiosk https://attendance.lan/ --edge-kiosk-type=fullscreen --no-first-run
```

- Put the shortcut in the kiosk user's Startup folder, or use **Assigned
  Access** (Settings → Accounts → Other users → *Set up a kiosk* → Microsoft
  Edge, full screen) for a locked-down device.
- Grant the camera without a prompt via policy:
  `VideoCaptureAllowedUrls = ["https://attendance.lan"]` (Chrome and Edge
  both support it; Group Policy or registry).
- Disable sleep/screen-off in power settings; the kiosk page has its own
  idle screen.

**Android**

- Chrome + **screen pinning** (Settings → Security → App pinning), or a kiosk
  browser such as Fully Kiosk Browser (enable *Web content → Enable webcam
  access* and set the start URL).
- Allow the camera when the site asks the first time.

**iPad**

- Safari, open the site, allow the camera, then **Guided Access**
  (Settings → Accessibility → Guided Access) to lock to Safari.

Mount the tablet at face height, facing away from windows (backlight ruins
recognition); even, frontal light works best.

## 7. Trusting the LAN certificate (`TLS_MODE=internal`)

Caddy creates a private root CA in the `caddy-data` volume and issues the
site certificate from it. Each kiosk and admin device must trust that root
once:

```sh
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt
```

| Device | Install |
|---|---|
| Windows | double-click → *Install Certificate* → Local Machine → *Trusted Root Certification Authorities*; or `certutil -addstore -f Root caddy-root.crt` (admin); or Group Policy for many PCs |
| Android | Settings → Security → Encryption & credentials → *Install a certificate* → *CA certificate* |
| iOS / iPadOS | open the file (AirDrop/mail) → install the profile → Settings → General → About → *Certificate Trust Settings* → enable full trust |
| macOS | Keychain Access → System → import → set *Always Trust* |
| ChromeOS | `chrome://certificate-manager` → Authorities → Import |

The root is valid for ~10 years; Caddy renews the site certificate itself.
**Keep the `caddy-data` volume** (and back it up): if it is deleted, Caddy
makes a new root and every device has to trust it again.

Alternative: use `TLS_MODE=files` with a certificate from your company CA
that devices already trust.

## 8. Backups and restore

The `backup` service runs `pg_dump` (custom format, compressed, verified
with `pg_restore --list`) right after start and then every
`BACKUP_INTERVAL_SECONDS` (default daily), keeping the newest
`BACKUP_KEEP` (default 14) in `BACKUP_DIR` (default `./backups`, files are
root-owned, mode 600).

```sh
docker compose logs backup                                         # history
docker compose exec backup sh /usr/local/bin/backup.sh --once      # back up now
```

**Copy backups off the machine.** A backup on the same disk dies with the
disk. For example, a nightly cron entry on the server:

```sh
15 3 * * *  rsync -a --delete /opt/attendance/backups/ backup-host:/srv/attendance-backups/
```

What a full recovery needs:

| Item | Where |
|---|---|
| database dumps | `./backups/` (copied off-site) |
| `FACE_DATA_KEY` and the rest of `backend/.env` | your secret store (never next to the dumps) |
| repo-root `.env` | same |
| `caddy-data` volume (LAN CA) | `docker run --rm -v <project>_caddy-data:/d -v "$PWD":/o alpine tar czf /o/caddy-data.tgz -C /d .` |
| anti-spoof / face models | `backend/models/` (re-downloadable) |

**Restore** (replaces the current database; takes a safety dump first,
stops the backend during the restore):

```sh
bash deploy/restore.sh backups/attendance-20261014T020000Z.dump
# non-interactive: FORCE=1 bash deploy/restore.sh <dump>
```

On a new machine: install the repo, put back both `.env` files (same
`FACE_DATA_KEY`!), `docker compose up -d --build`, then run the restore.
Test a restore on a spare machine at least every quarter.

## 9. Upgrades

```sh
git pull
docker compose up -d --build        # migrations run automatically on start
docker compose ps && docker compose logs --tail=50 backend
```

Take a backup first (`backup.sh --once`). Migrations run before gunicorn
starts; if one fails the backend exits and restarts instead of serving a
half-migrated schema — check `docker compose logs backend`.

Upgrading from the old compose file (backend ran as root, Vite dev server
on 5173): the log volume may still contain root-owned files. Fix once:

```sh
docker compose run --rm --no-deps --user root --entrypoint chown backend -R 10001:10001 /app/logs
```

and replace any old `http://...:5173` bookmarks on kiosks with
`https://SITE_ADDRESS/`.

## 10. Logs and monitoring

| What | Where |
|---|---|
| backend (requests, scan decisions with match scores, errors) | `docker compose logs -f backend`; rotating file `/app/logs/app.log` in the `backend-logs` volume (`docker compose exec backend tail -f /app/logs/app.log`) |
| edge access log (JSON) | `docker compose logs -f caddy` |
| backups | `docker compose logs backup` |
| database | `docker compose logs db` |

Container logs are capped at 5 × 10 MB per service.

**Health:** `GET https://SITE_ADDRESS/api/health` returns
`200 {"ok": true, "database": "ok"}`, or `503` when the database is
unreachable. Point an uptime monitor at it. `docker compose ps` shows each
container's own health check. Also alert on: the newest file in
`./backups` being older than 2 days, and disk usage.

## 11. Scaling and limits (by design)

The backend runs **exactly one** gunicorn eventlet worker. Socket.IO
sessions, login rate limits and lockouts, the blink-liveness pool and the
in-memory face embedding index all live in that process. One worker
comfortably serves dozens of kiosks; recognition runs in a native thread so
a scan does not stall other requests. Do **not** raise `-w` or run several
backend replicas: rate limits would be per-process, live updates would only
reach some dashboards, and liveness would break. Scaling out would need a
Socket.IO message queue (e.g. Redis) and shared rate-limit/liveness state,
which this version does not implement. Scale up (faster CPU) instead.

Restarting the backend clears in-memory rate-limit counters and the
liveness pool (harmless) and reloads the embedding index from the database.

## 12. Go-live checklist

- [ ] HTTPS works from every kiosk without a certificate warning; camera
      permission granted; kiosk launches full screen on boot.
- [ ] `FACE_DATA_KEY` and both `.env` files backed up off the server.
- [ ] A backup exists in `./backups`, an off-site copy job runs, and a test
      restore succeeded.
- [ ] `CORS_ORIGINS` lists the site's `https://` address, and the dashboard
      shows its live feed as connected.
- [ ] **Calibration on your cameras:** collect photos taken at the actual
      kiosks (same camera, light, distance) for 10+ enrolled people and some
      non-enrolled people, then run
      `python tools/evaluate_accuracy.py path/to/dataset` (layout in the
      script's docstring; `--max-far` defaults to 0.001). Only set
      `FACE_MATCH_THRESHOLD` if it recommends a different value.
- [ ] **Anti-spoofing:** MiniFASNet models installed; a printed photo and a
      phone screen are rejected and real people are not (otherwise
      `SPOOF_MODE=log` while you investigate). Liveness (`LIVENESS_REQUIRED`)
      left on.
- [ ] **Pilot:** run 1–2 weeks alongside the old method; review the Review
      queue and Records daily; re-enroll anyone with repeated misses.
- [ ] **Consent and retention:** employees informed and consent recorded as
      your jurisdiction requires (biometric data); retention settings match
      the written policy; a process to delete a leaver's biometrics
      (deleting an employee with attendance history archives the account and
      removes their face data).
- [ ] **Fallback procedure:** what staff do when the kiosk is down or does
      not recognise them (an administrator adds a manual entry in Records; manual
      entries are audited).
- [ ] Admin accounts use unique strong passwords; operators have only the
      OPERATOR role; kiosks use KIOSK device accounts.
- [ ] Uptime monitor on `/api/health`; someone receives its alerts.

---

## Development

```sh
docker compose -f docker-compose.dev.yml up --build
```

- `http://localhost:5173` — Vite dev server with hot reload (frontend source
  bind-mounted). It proxies `/api` and `/socket.io` to the backend, so
  cookies and Socket.IO behave as in production.
- `http://localhost:5000` — backend directly; `localhost:5432` — PostgreSQL
  (`attendance` / `attendance-dev`). All bound to 127.0.0.1 only.
- Separate project name (`attendance-dev`) and volumes: it never touches
  production data.
- Backend code is baked into the image; rebuild after Python changes
  (`docker compose -f docker-compose.dev.yml up -d --build backend`).

Without Docker: `cd backend && python run.py` (SQLite by default) and
`cd frontend && npm run dev`. The Vite proxy targets `http://localhost:5000`
unless `VITE_DEV_PROXY_TARGET` is set; set `VITE_USE_POLLING=true` if file
changes are not picked up (network drives, some bind mounts).

The camera only works on `localhost` or HTTPS, so test a phone or tablet
against the production-style stack (or a `localhost` port-forward), not the
dev server's LAN address.
