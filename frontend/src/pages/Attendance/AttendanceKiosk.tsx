import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { homeFor } from "../../components/AppShell";
import CameraView, { CameraTone } from "../../components/CameraView";
import Icon from "../../components/Icon";
import IdleScreen from "../../components/IdleScreen";
import { Avatar, EventBadge, Modal, Spinner, formatTime } from "../../components/ui";
import { frameDifference, useCamera } from "../../hooks/useCamera";
import { WAKE_EVENT, useIdle } from "../../hooks/useIdle";
import { useOnline } from "../../hooks/useOnline";
import { usePresenceWake } from "../../hooks/usePresenceWake";
import api, { errorMessage } from "../../services/api";
import { useAuthStore } from "../../stores/authStore";
import type { AttendanceEvent, CheckInResult } from "../../types";
import { guideZone } from "../../utils/guideZone";
import { BreakWindow, Direction, NOON, Session, defaultSession, sessionAllowed, sessionHint, toMinutes } from "../../utils/kioskSessions";
import { formatDate, formatTime as formatOrgTime, orgMinutesNow, orgNow, orgParts, useOrgStore } from "../../utils/orgTime";

// 8 frames ~110ms apart ≈ 0.8s capture. Enough for multi-frame matching;
// blink samples are pooled server-side across consecutive scans, so a blink
// in any scan within a few seconds counts.
const BURST_FRAMES = 8;
const BURST_INTERVAL_MS = 110;
const SUCCESS_HOLD_MS = 4000;
// A punch that didn't match the button pressed needs longer on screen —
// the employee has to actually read why it was changed.
const CORRECTED_HOLD_MS = 7000;
const NOTICE_HOLD_MS = 4000;
// With nobody touching the kiosk for this long, the idle screen (logo, greeting, clock) covers it.
const KIOSK_IDLE_MS = 60_000;
// After the idle screen is dismissed, taps are ignored for a moment so the wake-up tap
// can't land on a button underneath (Start scan, Admin…).
const WAKE_SHIELD_MS = 450;
// Presence polling while the idle screen is up: every second at first, backing off to every
// 4 seconds while nobody is there. A frame that barely differs from the last one checked is
// not sent at all (the answer can't have changed), except at least every PRESENCE_REFRESH_MS.
const PRESENCE_MIN_MS = 1000;
const PRESENCE_MAX_MS = 4000;
const PRESENCE_STILL_DIFF = 3; // mean grey-level change (0-255) below which the picture is "unchanged"
const PRESENCE_REFRESH_MS = 15_000;

export const CONNECTION_ERROR_TEXT = "Not recorded — check the connection and try again.";

type Phase =
  | { kind: "idle" }
  | { kind: "prompt"; text: string; tone: CameraTone }
  | { kind: "success"; event: AttendanceEvent; note?: string; reverifySeconds?: number }
  | { kind: "notice"; title: string; text: string; tone: "warn" | "error"; event?: AttendanceEvent; name?: string; userId?: string; hasPhoto?: boolean };

function deviceId() {
  try {
    let id = localStorage.getItem("kiosk_device_id");
    if (!id) {
      id = `kiosk-${Math.random().toString(36).slice(2, 8)}`;
      localStorage.setItem("kiosk_device_id", id);
    }
    return id;
  } catch {
    return "kiosk";
  }
}

// One AudioContext for the kiosk's lifetime: browsers cap how many can exist, and a new one per
// chime eventually stops making sound. It starts "suspended" until the first user gesture.
let audioCtx: AudioContext | null = null;
function audio(): AudioContext | null {
  if (audioCtx) return audioCtx;
  try {
    const Ctor = window.AudioContext || (window as any).webkitAudioContext;
    audioCtx = Ctor ? new Ctor() : null;
  } catch {
    audioCtx = null;
  }
  return audioCtx;
}

function chime(success: boolean) {
  try {
    const ctx = audio();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume().catch(() => undefined);
    const notes = success ? [880, 1318.5] : [330, 262];
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t = ctx.currentTime + i * 0.12;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.3);
    });
  } catch {
    /* audio is optional */
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The organisation's time (server clock and timezone), not the tablet's. */
function LiveClock() {
  const [now, setNow] = useState(orgNow);
  useOrgStore((st) => st.timeZone); // re-render when the org timezone arrives
  useEffect(() => {
    const t = setInterval(() => setNow(orgNow()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="min-w-0">
      <p className="whitespace-nowrap text-4xl font-extrabold tabular-nums leading-none tracking-tight text-white drop-shadow sm:text-6xl lg:text-7xl [@media(max-height:520px)]:!text-4xl">
        {formatOrgTime(now.toISOString())}
        <span className="ml-1.5 hidden text-2xl text-brand-400 sm:inline sm:text-3xl lg:text-4xl [@media(max-height:520px)]:!hidden">{String(orgParts(now).second).padStart(2, "0")}</span>
      </p>
      <p className="mt-1 truncate text-sm font-semibold text-neutral-100 drop-shadow sm:text-base lg:text-xl">{formatDate(now, { weekday: "long", month: "long", day: "numeric" })}</p>
    </div>
  );
}

type StatusOverride = "AUTO" | "AM_IN" | "AM_OUT" | "PM_IN" | "PM_OUT" | "OT_IN" | "OT_OUT";

/**
 * What the employee picks is only a hint: the server decides the punch that
 * is actually recorded and tells us when it overruled the selection (see
 * `corrected` on the response), so a wrong tap can't write a wrong record.
 * The kiosk picks a direction (in / out) and, when one is chosen, which part
 * of the day it belongs to; with nothing chosen it stays on Auto.
 */
/** Maps a kiosk selector choice to the (event_type, session) the API expects. */
function overridePunch(status: StatusOverride): { event_type?: "CLOCK_IN" | "CLOCK_OUT"; session?: "AM" | "PM" | "OT" } {
  if (status === "AUTO") return {};
  const [session, direction] = status.split("_") as ["AM" | "PM" | "OT", "IN" | "OUT"];
  return { event_type: direction === "IN" ? "CLOCK_IN" : "CLOCK_OUT", session };
}

export default function AttendanceKiosk() {
  const { videoRef, ready, starting, error, start, captureFrame, captureBurst, sampleThumbnail, isInfrared } = useCamera();
  const user = useAuthStore((st) => st.user);
  const unlockKiosk = useAuthStore((st) => st.unlockKiosk);
  // A KIOSK device account can never leave the kiosk; only staff accounts get the Admin button.
  const isDeviceAccount = user?.role === "KIOSK";
  const online = useOnline();
  // Scanning only ever runs when someone presses Start — no hands-free
  // continuous scanning by default. A successful or final scan result
  // automatically turns it back off (see hold()) so the next person has
  // to press Start again.
  const [auto, setAuto] = useState(false);
  const [direction, setDirection] = useState<Direction | null>(null);
  const [session, setSession] = useState<Session>("AM");
  // The organisation's clock and lunch break, from the server, so the morning / afternoon
  // choices follow the same rules the server applies (and the tablet's own clock can be wrong).
  const [breakWin, setBreakWin] = useState<BreakWindow>(NOON);
  const clockBase = useRef<{ minutes: number; at: number } | null>(null);
  const [nowMin, setNowMin] = useState(() => orgMinutesNow());
  const statusOverride: StatusOverride = direction ? (`${session}_${direction}` as StatusOverride) : "AUTO";
  // The scan loop reads the current selection through a ref, so changing it never restarts the loop.
  const statusOverrideRef = useRef(statusOverride);
  statusOverrideRef.current = statusOverride;
  // Exactly one check-in request at a time, whatever triggers it.
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [recent, setRecent] = useState<AttendanceEvent[]>([]);
  const [lastMs, setLastMs] = useState<number | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [wakeShield, setWakeShield] = useState(false);
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const ovalRef = useRef<HTMLDivElement>(null);
  const holdUntil = useRef(0);
  const streak = useRef({ noMatch: 0, unsure: 0 });
  const device = useRef(deviceId());

  // Fetch the organisation's time and break window now and every few minutes; between fetches
  // the clock advances locally.
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .get<{ local_minutes: number; break_start: string; break_end: string }>("/recognition/kiosk-config")
        .then((r) => {
          if (cancelled) return;
          clockBase.current = { minutes: r.data.local_minutes, at: Date.now() };
          setBreakWin({ start: toMinutes(r.data.break_start), end: toMinutes(r.data.break_end) });
          setNowMin(r.data.local_minutes);
        })
        .catch(() => undefined); // keep the local clock and the noon split
    const tick = () => {
      const base = clockBase.current;
      if (base) setNowMin((base.minutes + (Date.now() - base.at) / 60000) % 1440);
      else setNowMin(orgMinutesNow());
    };
    load();
    const refetch = setInterval(load, 10 * 60 * 1000);
    const clock = setInterval(tick, 15 * 1000);
    return () => {
      cancelled = true;
      clearInterval(refetch);
      clearInterval(clock);
    };
  }, []);

  // If time moves on (or the direction changes) so the chosen half-day is no longer
  // available, move to the one that is.
  useEffect(() => {
    if (direction && !sessionAllowed(session, direction, nowMin, breakWin)) setSession(defaultSession(direction, nowMin, breakWin));
  }, [direction, session, nowMin, breakWin]);

  // Start the camera automatically — a kiosk should be hands-free.
  useEffect(() => {
    start();
  }, [start]);

  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  // Clear result overlays after their hold time (the next person shouldn't
  // see a stranger's name), in both auto and manual mode.
  useEffect(() => {
    if (phase.kind !== "success" && phase.kind !== "notice") return;
    const t = setTimeout(() => setPhase({ kind: "idle" }), Math.max(0, holdUntil.current - Date.now()));
    return () => clearTimeout(t);
  }, [phase]);

  // A hold means this person's scan is finished (success, cooldown notice,
  // or a final error) — turn scanning back off so the next person presses
  // Start themselves, instead of the kiosk scanning an empty space.
  const hold = (p: Phase, ms: number) => {
    setPhase(p);
    holdUntil.current = Date.now() + ms;
    setAuto(false);
  };

  /** One scan. Returns how long to wait before the next automatic scan. */
  const scanOnce = useCallback(async (): Promise<number> => {
    if (inFlight.current) return 200;
    inFlight.current = true;
    setBusy(true);
    try {
      const frames = await captureBurst(BURST_FRAMES, BURST_INTERVAL_MS);
      if (frames.length === 0) return 500;
      const form = new FormData();
      frames.forEach((b, i) => form.append("frames", b, `f${i}.jpg`));
      form.append("device_id", device.current);
      const zone = guideZone(videoRef.current, ovalRef.current);
      if (zone) form.append("zone", JSON.stringify(zone));
      const punch = overridePunch(statusOverrideRef.current);
      if (punch.event_type) form.append("event_type", punch.event_type);
      if (punch.session) form.append("session", punch.session);
      const started = performance.now();
      const { data } = await api.post<CheckInResult>("/recognition/check-in", form);
      setLastMs(Math.round(performance.now() - started));

      switch (data.status) {
        case "MATCHED": {
          streak.current = { noMatch: 0, unsure: 0 };
          chime(true);
          setDirection(null);
          setRecent((r) => [data.event!, ...r].slice(0, 6));
          const ms = data.corrected ? CORRECTED_HOLD_MS : SUCCESS_HOLD_MS;
          hold(
            { kind: "success", event: data.event!, note: data.correction_note ?? undefined, reverifySeconds: data.reverify_seconds },
            ms
          );
          return ms;
        }
        case "COOLDOWN":
          streak.current = { noMatch: 0, unsure: 0 };
          hold(
            { kind: "notice", title: `Already recorded, ${data.user_name?.split(" ")[0] ?? ""}`, text: data.reason || "", tone: "warn", event: data.event, name: data.user_name, userId: data.user_id, hasPhoto: data.has_photo },
            NOTICE_HOLD_MS
          );
          return NOTICE_HOLD_MS;
        case "VERIFIED":
          streak.current = { noMatch: 0, unsure: 0 };
          chime(true);
          hold(
            { kind: "notice", title: `Verified, ${data.user_name?.split(" ")[0] ?? ""}`, text: data.reason || "", tone: "warn", event: data.event, name: data.user_name, userId: data.user_id, hasPhoto: data.has_photo },
            NOTICE_HOLD_MS
          );
          return NOTICE_HOLD_MS;
        case "LIVENESS_FAILED":
          setPhase({ kind: "prompt", text: `Hi ${data.first_name ?? "there"}! Please blink 👀`, tone: "scanning" });
          return 0;
        case "SPOOF_SUSPECTED":
          streak.current = { noMatch: 0, unsure: 0 };
          chime(false);
          hold({ kind: "notice", title: "Live face required", text: data.reason || "Photos and screens are not accepted. Face the camera directly.", tone: "error" }, NOTICE_HOLD_MS);
          return NOTICE_HOLD_MS;
        case "LOW_CONFIDENCE":
        case "AMBIGUOUS_MATCH":
          streak.current.unsure += 1;
          if (streak.current.unsure >= 4) {
            streak.current.unsure = 0;
            hold({ kind: "notice", title: "Can't confirm who you are", text: data.reason || "Face the camera directly in good light, remove sunglasses or mask, and hold still.", tone: "warn" }, NOTICE_HOLD_MS);
            return NOTICE_HOLD_MS;
          }
          setPhase({ kind: "prompt", text: data.reason || "Hold still and look at the camera", tone: "scanning" });
          return 150;
        case "NO_MATCH":
          streak.current.noMatch += 1;
          if (streak.current.noMatch >= 2) {
            streak.current.noMatch = 0;
            chime(false);
            hold({ kind: "notice", title: "Not recognized", text: "You don't appear to be enrolled. Please see an administrator.", tone: "error" }, NOTICE_HOLD_MS);
            return NOTICE_HOLD_MS;
          }
          setPhase({ kind: "prompt", text: "Checking… look at the camera", tone: "scanning" });
          return 150;
        case "NO_FACE":
        default:
          streak.current = { noMatch: 0, unsure: 0 };
          setPhase(
            data.reason?.startsWith("Multiple")
              ? { kind: "prompt", text: "One person at a time, please", tone: "warn" }
              : data.reason?.startsWith("Move")
                ? { kind: "prompt", text: data.reason, tone: "warn" }
                : { kind: "idle" }
          );
          return 450;
      }
    } catch (err: any) {
      chime(false);
      if (!err?.response) hold({ kind: "notice", title: "Connection problem", text: CONNECTION_ERROR_TEXT, tone: "error" }, NOTICE_HOLD_MS);
      else hold({ kind: "notice", title: "Not recorded", text: errorMessage(err, "Check-in failed. Please try again."), tone: "error" }, NOTICE_HOLD_MS);
      return NOTICE_HOLD_MS;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [captureBurst, videoRef]);

  // Scanning loop — only runs once armed by pressing Start (see `auto`
  // above). Keeps scanning the person in front of the camera until a
  // result holds (which turns `auto` back off), then stops.
  useEffect(() => {
    // Offline: pause (the loop resumes by itself when the connection returns).
    if (!auto || !ready || !online) return;
    let cancelled = false;
    (async () => {
      while (!cancelled) {
        const wait = holdUntil.current - Date.now();
        if (wait > 0) {
          await sleep(wait);
          if (cancelled) break;
          setPhase({ kind: "idle" });
        }
        const next = await scanOnce();
        if (cancelled) break;
        await sleep(Math.max(next, 60));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [auto, ready, online, scanOnce]);

  // Browsers only let audio play after a user gesture: wake the shared AudioContext on the first one.
  useEffect(() => {
    const unlockAudio = () => {
      audio()?.resume().catch(() => undefined);
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);
    };
    window.addEventListener("pointerdown", unlockAudio);
    window.addEventListener("keydown", unlockAudio);
    return () => {
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);
    };
  }, []);

  function pickDirection(d: Direction) {
    if (direction === d) {
      setDirection(null); // tapping the active choice goes back to Auto
      return;
    }
    setSession((cur) => (cur === "OT" ? cur : defaultSession(d, nowMin, breakWin)));
    setDirection(d);
  }

  function startScan() {
    if (!online) return;
    holdUntil.current = 0;
    setPhase({ kind: "idle" });
    setAuto(true);
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else containerRef.current?.requestFullscreen?.();
  }

  const tone: CameraTone =
    phase.kind === "success" ? "success" : phase.kind === "notice" ? (phase.tone === "error" ? "error" : "warn") : phase.kind === "prompt" ? phase.tone : busy ? "scanning" : "idle";

  // The idle screen never covers a scan or a result in progress, nor the password prompt;
  // when any of those ends, the idle countdown starts afresh.
  const idle = useIdle(KIOSK_IDLE_MS, auto || busy || phase.kind !== "idle" || unlockOpen);
  const wasIdle = useRef(false);
  useEffect(() => {
    if (idle) {
      wasIdle.current = true;
      return;
    }
    if (!wasIdle.current) return;
    wasIdle.current = false;
    setWakeShield(true);
    const t = setTimeout(() => setWakeShield(false), WAKE_SHIELD_MS);
    return () => clearTimeout(t);
  }, [idle]);

  // While the idle screen is up the camera keeps running: a small frame goes to the server about
  // once a second to ask whether someone has walked up (inside the circle, close enough), and
  // the screen wakes. The frame is only checked for a face; nothing is stored or identified.
  const lastPresence = useRef<{ thumb: Uint8ClampedArray | null; present: boolean; at: number } | null>(null);
  useEffect(() => {
    if (!idle) lastPresence.current = null;
  }, [idle]);
  usePresenceWake({
    enabled: idle && ready && online,
    intervalMs: PRESENCE_MIN_MS,
    maxIntervalMs: PRESENCE_MAX_MS,
    check: async () => {
      // Nothing moved since the last answer: it still stands, no need to ask the server.
      const thumb = sampleThumbnail();
      const last = lastPresence.current;
      if (last && Date.now() - last.at < PRESENCE_REFRESH_MS && frameDifference(thumb, last.thumb) < PRESENCE_STILL_DIFF) return last.present;
      const frame = await captureFrame(0.6, 480);
      if (!frame) return false;
      const form = new FormData();
      form.append("frame", frame, "presence.jpg");
      const zone = guideZone(videoRef.current, ovalRef.current);
      if (zone) form.append("zone", JSON.stringify(zone));
      const present = (await api.post<{ present: boolean }>("/recognition/presence", form)).data.present;
      lastPresence.current = { thumb, present, at: Date.now() };
      return present;
    },
    onWake: () => window.dispatchEvent(new Event(WAKE_EVENT)),
  });

  // Prompts that matter while someone is standing there ("blink", "hold still", "scanning…").
  // The idle "press Start" hint is redundant next to the big button, so it is not shown.
  const prompt = phase.kind === "prompt" ? phase.text : phase.kind === "idle" && ready && auto && online ? "Scanning… look at the camera" : undefined;
  // The controls step aside while a result is on screen.
  const showControls = phase.kind === "idle" || phase.kind === "prompt";
  const glass = "border border-white/10 bg-black/55 backdrop-blur-md";
  const hudBtn = `${glass} flex h-12 min-w-12 items-center justify-center gap-2 rounded-full px-4 text-base font-semibold text-white transition-colors hover:bg-black/75 active:scale-95`;
  const DIRECTIONS = [
    { value: null, label: "Auto", on: "bg-brand-500 text-black" },
    { value: "IN", label: "Time in", on: "bg-emerald-500 text-black" },
    { value: "OUT", label: "Time out", on: "bg-orange-500 text-black" },
  ] as const;
  const SESSIONS = [
    { value: "AM", label: "Morning" },
    { value: "PM", label: "Afternoon" },
    { value: "OT", label: "Overtime" },
  ] as const;
  const seg = "min-w-0 flex-1 truncate rounded-xl font-bold transition-all active:scale-95";
  const startBtn =
    "flex w-full items-center justify-center gap-3 rounded-2xl text-3xl font-extrabold transition-transform active:scale-[.97] h-24 sm:h-28 sm:text-4xl [@media(orientation:landscape)_and_(min-width:700px)]:h-full [@media(orientation:landscape)_and_(min-width:700px)]:flex-col [@media(orientation:landscape)_and_(min-width:700px)]:gap-2 [@media(max-height:520px)]:!h-full [@media(max-height:520px)]:!flex-row [@media(max-height:520px)]:!text-xl";

  return (
    <div ref={containerRef} className="absolute inset-0 touch-manipulation select-none bg-black">
      <CameraView
        fill
        ovalRef={ovalRef}
        videoRef={videoRef}
        ready={ready}
        starting={starting}
        onStart={start}
        tone={tone}
        scanning={busy || phase.kind === "prompt"}
        isInfrared={isInfrared}
        allowCameraSwitch={false}
        toolsClass="right-4 top-24 sm:top-28"
        ovalClass="top-[42%] h-[42%] sm:top-[44%] sm:h-[50%] [@media(orientation:landscape)_and_(min-height:521px)]:top-[46%] [@media(orientation:landscape)_and_(min-height:521px)]:h-[56%] [@media(max-height:520px)]:top-[43%] [@media(max-height:520px)]:h-[46%]"
        overlay={
          <>
            <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-black/70 to-transparent" />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-72 bg-gradient-to-t from-black/70 to-transparent" />

            {/* Top bar: clock on the left, window controls on the right */}
            <div className="absolute inset-x-0 top-0 flex items-start justify-between gap-3 px-[max(1rem,env(safe-area-inset-left))] pt-[max(1rem,env(safe-area-inset-top))] sm:px-6 sm:pt-6">
              <div className="flex min-w-0 items-center gap-3 sm:gap-4">
                <img src="/logo.png" alt="Ala Eh! Food Products" className="h-12 w-12 shrink-0 rounded-full shadow-glow sm:h-16 sm:w-16 lg:h-20 lg:w-20 [@media(max-height:520px)]:!h-11 [@media(max-height:520px)]:!w-11" />
                <LiveClock />
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button onClick={toggleFullscreen} className={hudBtn} title="Toggle fullscreen" aria-label="Toggle fullscreen">
                  <Icon name="expand" className="h-5 w-5" />
                  <span className="hidden md:inline">{fullscreen ? "Exit fullscreen" : "Fullscreen"}</span>
                </button>
                {isDeviceAccount ? (
                  <span
                    className={`${glass} hidden items-center gap-2 rounded-full px-4 py-2 text-xs font-medium text-neutral-300 sm:flex`}
                    title="This tablet is signed in with a kiosk device account. To sign it out, an administrator deactivates or revokes the account."
                  >
                    <Icon name="shield" className="h-4 w-4 text-brand-400" /> Kiosk device
                  </span>
                ) : (
                  <button onClick={() => setUnlockOpen(true)} className={hudBtn} title="Back to the admin portal (password required)" aria-label="Back to admin">
                    <Icon name="key" className="h-5 w-5 text-brand-400" />
                    <span className="hidden md:inline">Admin</span>
                  </button>
                )}
              </div>
            </div>

            {/* Prompt while someone is being scanned */}
            {prompt && showControls && (
              <div className="pointer-events-none absolute inset-x-0 top-24 flex justify-center px-4 sm:top-28 [@media(max-height:520px)]:top-3 [@media(max-height:520px)]:px-[17rem]">
                <span key={prompt} className={`${glass} whitespace-nowrap rounded-full px-6 py-2.5 text-center text-base font-semibold text-white animate-fade-up sm:text-xl [@media(max-height:520px)]:!px-4 [@media(max-height:520px)]:!py-1.5 [@media(max-height:520px)]:!text-sm`}>
                  {prompt}
                </span>
              </div>
            )}

            {!online && (
              <div role="alert" className="absolute inset-x-4 top-24 z-10 mx-auto flex max-w-xl items-center gap-2 rounded-xl border border-orange-400/50 bg-black/85 px-4 py-3 text-sm font-semibold text-orange-200 backdrop-blur sm:top-28">
                <Icon name="alert" className="h-4 w-4 shrink-0" /> No network connection. Scanning is paused until it is back.
              </div>
            )}

            {error && (
              <div role="alert" className="absolute inset-x-4 top-36 mx-auto flex max-w-xl items-center gap-2 rounded-xl border border-red-500/40 bg-black/80 px-4 py-3 text-sm text-red-300 backdrop-blur">
                <Icon name="alert" className="h-4 w-4 shrink-0" /> {error}
              </div>
            )}

            {/* Recent check-ins, only where there is spare room beside the face window */}
            {recent.length > 0 && (
              <div className="absolute left-6 top-1/2 hidden w-72 -translate-y-1/2 space-y-2 [@media(orientation:landscape)_and_(min-width:1000px)_and_(min-height:600px)]:block">
                {recent.slice(0, 3).map((e) => (
                  <div key={e.id} className={`${glass} flex items-center gap-3 rounded-2xl p-2.5 animate-slide-in`}>
                    <Avatar userId={e.user_id} name={e.user_name} hasPhoto={e.has_photo} size="h-10 w-10" text="text-xs" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-white">{e.user_name}</p>
                      <p className="text-xs tabular-nums text-neutral-400">{formatTime(e.timestamp)}</p>
                    </div>
                    <EventBadge type={e.event_type} session={e.session} />
                  </div>
                ))}
              </div>
            )}

            {/* Control dock: choose time in / out (optional), then the big Start scan */}
            {showControls && (
              <div className="absolute inset-x-0 bottom-0 flex justify-center px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-6">
                <div
                  className={`${glass} grid w-full max-w-3xl gap-3 rounded-3xl p-3 sm:p-4 [@media(orientation:landscape)_and_(min-width:700px)]:grid-cols-[1fr_36%] [@media(max-height:520px)]:grid-cols-[1fr_36%] [@media(max-height:520px)]:gap-2 [@media(max-height:520px)]:p-2`}
                >
                  <div className="flex min-w-0 flex-col gap-2">
                    <div className="flex gap-1 rounded-2xl bg-white/[0.06] p-1" role="group" aria-label="Time in or time out">
                      {DIRECTIONS.map((d) => (
                        <button
                          key={d.label}
                          onClick={() => (d.value ? pickDirection(d.value) : setDirection(null))}
                          aria-pressed={direction === d.value}
                          disabled={busy}
                          className={`${seg} h-14 text-lg disabled:opacity-50 sm:h-16 sm:text-xl [@media(max-height:520px)]:!h-11 [@media(max-height:520px)]:!text-base ${direction === d.value ? d.on : "text-neutral-200 hover:bg-white/10"}`}
                        >
                          {d.label}
                        </button>
                      ))}
                    </div>
                    <div className="flex h-11 items-center sm:h-12 [@media(max-height:520px)]:!h-9">
                      {direction ? (
                        <div className="flex h-full w-full gap-1 rounded-xl bg-white/[0.06] p-1" role="group" aria-label="Which part of the day">
                          {SESSIONS.map((o) => (
                            <button
                              key={o.value}
                              onClick={() => setSession(o.value)}
                              aria-pressed={session === o.value}
                              disabled={busy || !sessionAllowed(o.value, direction, nowMin, breakWin)}
                              title={sessionAllowed(o.value, direction, nowMin, breakWin) ? undefined : sessionHint(o.value, direction, breakWin)}
                              className={`${seg} rounded-lg text-sm disabled:cursor-not-allowed disabled:opacity-30 disabled:active:scale-100 sm:text-base ${session === o.value ? "bg-white text-black" : "text-neutral-200 hover:bg-white/10"}`}
                            >
                              {o.label}
                            </button>
                          ))}
                        </div>
                      ) : (
                        <p className="w-full text-center text-sm font-medium text-neutral-300 sm:text-base">Auto picks time in or time out for you</p>
                      )}
                    </div>
                  </div>
                  {ready &&
                    (auto ? (
                      <button onClick={() => setAuto(false)} className={`${startBtn} border-2 border-red-400/60 bg-red-500/15 text-red-200 hover:bg-red-500/25`}>
                        <Icon name="pause" className="h-9 w-9 sm:h-11 sm:w-11 [@media(max-height:520px)]:!h-6 [@media(max-height:520px)]:!w-6" strokeWidth={2.2} /> Stop
                      </button>
                    ) : (
                      <button onClick={startScan} disabled={!online} className={`${startBtn} disabled:cursor-not-allowed disabled:opacity-50 bg-brand-500 text-black shadow-[0_0_50px_-8px_rgba(245,192,0,.8)] hover:bg-brand-400`}>
                        <Icon name="scan" className="h-9 w-9 sm:h-11 sm:w-11 [@media(max-height:520px)]:!h-6 [@media(max-height:520px)]:!w-6" strokeWidth={2.2} /> Start scan
                      </button>
                    ))}
                </div>
              </div>
            )}

            {phase.kind === "success" && <SuccessOverlay phase={phase} />}
            {phase.kind === "notice" && <NoticeOverlay phase={phase} />}
          </>
        }
      />

      {idle && <IdleScreen hint="Step up to the camera or tap the screen" />}
      {wakeShield && <div className="fixed inset-0 z-[99]" aria-hidden="true" />}

      <KioskUnlock
        open={unlockOpen}
        onClose={() => setUnlockOpen(false)}
        unlock={unlockKiosk}
        onUnlocked={() => {
          if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined);
          // Operators' home is the kiosk itself; send both admins and operators to the portal.
          navigate(user && homeFor(user.role) !== "/kiosk" ? homeFor(user.role) : "/admin", { replace: true });
        }}
      />
    </div>
  );
}

/** Password prompt guarding the way back into the admin portal. */
function KioskUnlock({ open, onClose, onUnlocked, unlock }: { open: boolean; onClose: () => void; onUnlocked: () => void; unlock: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (open) {
      setPassword("");
      setError(null);
    }
  }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!password || checking) return;
    setChecking(true);
    setError(null);
    try {
      // Server-enforced: swaps the kiosk-locked session for a normal one.
      await unlock(password);
      onUnlocked();
    } catch (err: any) {
      const code = err?.response?.data?.code;
      setError(code === "WRONG_PASSWORD" ? "Wrong password. Try again." : errorMessage(err, "Could not verify the password."));
      setPassword("");
    } finally {
      setChecking(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Back to admin">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-neutral-400">Enter your password to leave the kiosk and open the admin portal.</p>
        <input
          type="password"
          className="input"
          placeholder="Password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-label="Password"
        />
        {error && (
          <p role="alert" className="text-sm text-red-300">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <button type="button" className="btn-ghost flex-1" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary flex-1" disabled={!password || checking}>
            {checking ? <Spinner /> : <Icon name="key" className="h-4 w-4" />} Unlock
          </button>
        </div>
      </form>
    </Modal>
  );
}

function SuccessOverlay({ phase }: { phase: Extract<Phase, { kind: "success" }> }) {
  const { event, note, reverifySeconds } = phase;
  const isIn = event.event_type === "CLOCK_IN";
  return (
    <div className="absolute inset-0 flex overflow-y-auto bg-black/70 p-4 backdrop-blur-md animate-fade-in">
      <div className="m-auto flex w-full max-w-md flex-col items-center text-center animate-scale-in">
        <div className="relative mb-4 [@media(max-height:520px)]:mb-2">
          <span className="absolute -inset-3 rounded-full bg-emerald-500/25 animate-pulse-ring" />
          <Avatar userId={event.user_id} name={event.user_name} hasPhoto={event.has_photo} size="h-20 w-20 sm:h-28 sm:w-28 lg:h-32 lg:w-32 [@media(max-height:520px)]:h-16 [@media(max-height:520px)]:w-16" text="text-2xl sm:text-3xl" ring />
          <span className="absolute -bottom-1 -right-1 flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500 text-black ring-4 ring-black">
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" strokeDasharray="48" className="animate-draw-check" />
            </svg>
          </span>
        </div>
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-brand-400">{isIn ? "Good day" : "See you"}</p>
        <p className="mt-1 text-2xl font-extrabold tracking-tight text-white sm:text-3xl lg:text-4xl">{event.user_name}</p>
        {(event.employee_code || event.department) && (
          <p className="mt-1 text-sm text-neutral-400">{[event.employee_code, event.department].filter(Boolean).join(" · ")}</p>
        )}
        <div className="mt-4 flex flex-wrap items-center justify-center gap-3 rounded-2xl border border-white/10 bg-white/[0.04] px-5 py-3 [@media(max-height:520px)]:mt-2 [@media(max-height:520px)]:py-2">
          <EventBadge type={event.event_type} session={event.session} late={event.is_late} lateMinutes={event.late_minutes} earlyMinutes={event.early_minutes} />
          <span className="text-xl font-bold tabular-nums text-white sm:text-2xl">{formatTime(event.timestamp)}</span>
        </div>
        {note && (
          <p className="mt-3 max-w-sm rounded-xl border border-orange-400/40 bg-orange-500/10 px-4 py-2 text-sm text-orange-200">
            <Icon name="alert" className="mr-1.5 inline h-4 w-4 align-[-3px]" />
            {note}
          </p>
        )}
        {!!reverifySeconds && (
          <p className="mt-3 text-xs text-neutral-400">
            Not sure it registered? Scan again within {reverifySeconds}s — it will only re-confirm this punch, never add another.
          </p>
        )}
      </div>
    </div>
  );
}

function NoticeOverlay({ phase }: { phase: Extract<Phase, { kind: "notice" }> }) {
  const isError = phase.tone === "error";
  return (
    <div className="absolute inset-x-0 bottom-0 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] animate-fade-up">
      <div className={`flex items-center gap-4 rounded-2xl border bg-black/80 p-4 backdrop-blur-md ${isError ? "border-red-500/40" : "border-orange-400/40"}`}>
        {phase.userId ? (
          <Avatar userId={phase.userId} name={phase.name} hasPhoto={phase.hasPhoto} size="h-12 w-12" />
        ) : (
          <span className={`rounded-xl p-3 ${isError ? "bg-red-500/15 text-red-300" : "bg-orange-500/15 text-orange-300"}`}>
            <Icon name={isError ? "x_circle" : "alert"} className="h-6 w-6" />
          </span>
        )}
        <div className="min-w-0">
          <p className="font-bold text-white">{phase.title}</p>
          <p className="text-sm text-neutral-300">
            {phase.event ? `${phase.event.punch_label ?? (phase.event.event_type === "CLOCK_IN" ? "Clocked in" : "Clocked out")} at ${formatTime(phase.event.timestamp)}. ` : ""}
            {phase.text}
          </p>
        </div>
      </div>
    </div>
  );
}
