import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { homeFor } from "../../components/AppShell";
import CameraView, { CameraTone } from "../../components/CameraView";
import FaceDebugOverlay from "../../components/FaceDebugOverlay";
import Icon from "../../components/Icon";
import IdleScreen from "../../components/IdleScreen";
import { Avatar, EventBadge, formatTime } from "../../components/ui";
import { frameDifference, useCamera } from "../../hooks/useCamera";
import { WAKE_EVENT, useIdle } from "../../hooks/useIdle";
import { useOnline } from "../../hooks/useOnline";
import { useLiveDetection } from "../../hooks/useLiveDetection";
import { SHORT_SCREEN, useOvalFit } from "../../hooks/useOvalFit";
import { usePresenceWake } from "../../hooks/usePresenceWake";
import api, { errorMessage } from "../../services/api";
import { useAuthStore } from "../../stores/authStore";
import type { AttendanceEvent, CheckInResult } from "../../types";
import { useFaceDebug } from "../../utils/faceDebug";
import { guideZone } from "../../utils/guideZone";
import { BreakWindow, Direction, NOON, Session, defaultSession, sessionAllowed, sessionHint, toMinutes } from "../../utils/kioskSessions";
import { orgMinutesNow } from "../../utils/orgTime";
import { type Cue, NO_STREAK, type Phase, type Outcome, interpretCheckIn, interpretRequestFailure } from "./kioskOutcome";
import { StatusOverride, deviceId, overridePunch } from "./kioskPunch";
import KioskUnlock from "./KioskUnlock";
import LiveClock from "./LiveClock";
import { NoticeOverlay, SuccessOverlay } from "./ResultOverlays";
import { chime, preloadVoice, say, sayOnce, stopSpeaking, useAudioUnlock } from "../../utils/sound";

// 8 frames ~110ms apart ≈ 0.8s capture. Enough for multi-frame matching;
// blink samples are pooled server-side across consecutive scans, so a blink
// in any scan within a few seconds counts.
const BURST_FRAMES = 8;
const BURST_INTERVAL_MS = 110;
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Plays one of the kiosk's sounds. */
function playCue(cue: Cue) {
  if ("chime" in cue) chime(cue.chime);
  else if ("say" in cue) (cue.delay === undefined ? say(cue.say) : say(cue.say, cue.delay));
  else sayOnce(cue.sayOnce, cue.gap);
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
  const topBarRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  // The face window takes the room between the top bar (and the prompt under it) and the controls.
  const ovalStyle = useOvalFit({
    container: containerRef,
    top: topBarRef,
    bottom: dockRef,
    // The prompt pill sits under the top bar (beside it on a short screen). The floor is the size the oval had before it was measured.
    topReserve: (c) => (c.height <= SHORT_SCREEN ? 0 : c.width >= 640 ? 156 : 140),
    floorShare: (c) => (c.height <= SHORT_SCREEN ? 0.46 : c.width > c.height ? 0.56 : c.width >= 640 ? 0.5 : 0.42),
  });
  // Development only: what the server's detector saw, drawn over the camera.
  const faceDebug = useFaceDebug();
  const { wants: wantsDebug, report: reportDebug } = faceDebug;
  const holdUntil = useRef(0);
  const streak = useRef(NO_STREAK);
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

  /** Does what the interpreted answer says: sounds, the phase on screen, the recent list. Returns the wait before the next scan. */
  const applyOutcome = (outcome: Outcome): number => {
    outcome.cues.forEach(playCue);
    if (outcome.recordedEvent) {
      const event = outcome.recordedEvent;
      setDirection(null);
      setRecent((r) => [event, ...r].slice(0, 6));
    }
    if (outcome.holdMs !== undefined) hold(outcome.phase, outcome.holdMs);
    else setPhase(outcome.phase);
    return outcome.waitMs;
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
      if (wantsDebug()) form.append("debug", "1");
      const zone = guideZone(videoRef.current, ovalRef.current);
      if (zone) form.append("zone", JSON.stringify(zone));
      const punch = overridePunch(statusOverrideRef.current);
      if (punch.event_type) form.append("event_type", punch.event_type);
      if (punch.session) form.append("session", punch.session);
      const started = performance.now();
      const { data } = await api.post<CheckInResult>("/recognition/check-in", form);
      setLastMs(Math.round(performance.now() - started));
      reportDebug(data.debug);

      const { outcome, streak: nextStreak } = interpretCheckIn(data, streak.current);
      streak.current = nextStreak;
      return applyOutcome(outcome);
    } catch (err: any) {
      return applyOutcome(interpretRequestFailure(err, CONNECTION_ERROR_TEXT, (e) => errorMessage(e, "Check-in failed. Please try again.")));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }, [captureBurst, videoRef, wantsDebug, reportDebug]);

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

  useAudioUnlock();
  // Fetch the spoken confirmations ahead of time so the first one isn't late; leaving the kiosk silences a pending one.
  useEffect(() => {
    preloadVoice();
    return stopSpeaking;
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
    say("kiosk.start");
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
  // Development only: follow the face continuously, even before Start scan is pressed. It stands down while a scan request
  // is in flight (that answer carries its own reading), on the idle screen, and behind the password prompt.
  useLiveDetection({
    enabled: faceDebug.available && faceDebug.on && ready && online && !busy && !idle && !unlockOpen,
    captureFrame,
    videoRef,
    ovalRef,
    report: reportDebug,
  });
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
  const glass = "border border-white/10 bg-black/55";
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
  const seg = "min-w-0 flex-1 truncate rounded-xl font-bold transition-colors active:scale-95";
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
        // Until the real layout has been measured (see useOvalFit), these percentages stand in for it.
        ovalClass="top-[42%] h-[42%] sm:top-[44%] sm:h-[50%] [@media(orientation:landscape)_and_(min-height:521px)]:top-[46%] [@media(orientation:landscape)_and_(min-height:521px)]:h-[56%] [@media(max-height:520px)]:top-[43%] [@media(max-height:520px)]:h-[46%]"
        ovalStyle={ovalStyle}
        overlay={
          <>
            <FaceDebugOverlay debug={faceDebug} kind="scan" />
            <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-black/70 to-transparent" />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 h-72 bg-gradient-to-t from-black/70 to-transparent" />

            {/* Top bar: clock on the left, window controls on the right */}
            <div ref={topBarRef} className="absolute inset-x-0 top-0 flex items-start justify-between gap-3 px-[max(1rem,env(safe-area-inset-left))] pt-[max(1rem,env(safe-area-inset-top))] sm:px-6 sm:pt-6">
              <div className="flex min-w-0 items-center gap-3 sm:gap-4">
                <img src="/logo.png" alt="Ala Eh! Food Products" className="h-12 w-12 shrink-0 rounded-full sm:h-16 sm:w-16 lg:h-20 lg:w-20 [@media(max-height:520px)]:!h-11 [@media(max-height:520px)]:!w-11" />
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
              <div role="alert" className="absolute inset-x-4 top-24 z-10 mx-auto flex max-w-xl items-center gap-2 rounded-xl border border-orange-400/50 bg-black/85 px-4 py-3 text-sm font-semibold text-orange-200 sm:top-28">
                <Icon name="alert" className="h-4 w-4 shrink-0" /> No network connection. Scanning is paused until it is back.
              </div>
            )}

            {error && (
              <div role="alert" className="absolute inset-x-4 top-36 mx-auto flex max-w-xl items-center gap-2 rounded-xl border border-red-500/40 bg-black/80 px-4 py-3 text-sm text-red-300">
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
                  ref={dockRef}
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
                      <button onClick={startScan} disabled={!online} className={`${startBtn} disabled:cursor-not-allowed disabled:opacity-50 bg-brand-500 text-black hover:bg-brand-400`}>
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

      {idle && <IdleScreen variant="kiosk" hint="Step up to the camera or tap the screen" />}
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
