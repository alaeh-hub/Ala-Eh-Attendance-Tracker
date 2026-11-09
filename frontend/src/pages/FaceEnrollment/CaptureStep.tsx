import { useCallback, useEffect, useRef, useState } from "react";
import { isCancelled, retryAfterSeconds } from "../../components/admin/request";
import CameraView, { CameraTone } from "../../components/CameraView";
import FaceDebugOverlay from "../../components/FaceDebugOverlay";
import Icon from "../../components/Icon";
import { Avatar, ConfirmDialog, Spinner, forgetPhoto } from "../../components/ui";
import { useCamera } from "../../hooks/useCamera";
import { SHORT_SCREEN, useOvalFit } from "../../hooks/useOvalFit";
import api, { errorMessage } from "../../services/api";
import type { EnrollmentStatus, User } from "../../types";
import { type FaceDebug, useFaceDebug } from "../../utils/faceDebug";
import { guideZone } from "../../utils/guideZone";
import { type VoiceKey, chime, isVoiceKey, preloadVoice, say, sayOnce, speak, stopSpeaking, useAudioUnlock } from "../../utils/sound";
import CaptureBanner from "./CaptureBanner";
import CapturePanels from "./CapturePanels";
import { dockBtn, ghostBtn, glass, hudBtn } from "./captureStyles";
import {
  AUTO_CAPTURE_INTERVAL_MS,
  LEAD_IN_MS,
  NOTICE_MS,
  type Notice,
  POSES,
  REJECT_PAUSE_MS,
  RETRY_VOICE_GAP_MS,
  SUCCESS_NOTICE_MS,
  VOICE_AFTER_CHIME_MS,
  type Calibration,
  loadCalibration,
  saveCalibration,
} from "./poses";

/* Step 2 — guided capture: the camera, the live readiness check and the pose-by-pose sample upload. */

export default function CaptureStep({ employee, onBack, onDone }: { employee: User; onBack: () => void; onDone: (u: User) => void }) {
  const { videoRef, ready, starting, error: cameraError, start, stop, captureFrame, devices, deviceId, isInfrared, switchCamera } = useCamera();
  const [poses, setPoses] = useState<string[]>(Object.keys(POSES));
  const [status, setStatus] = useState<EnrollmentStatus | null>(null);
  const [captured, setCaptured] = useState<string[]>([]);
  const [auto, setAuto] = useState(true);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<{ text: string; tone: CameraTone } | null>(null);
  const [blocking, setBlocking] = useState<string | null>(null); // duplicate / inconsistent face
  const [flash, setFlash] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [consent, setConsent] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [readiness, setReadiness] = useState<{ ready: boolean; score: number; reason: string | null } | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [soundOn, setSoundOn] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const topBarRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  // The face window takes the room between the top bar (and the pose banner under it) and the controls.
  const ovalStyle = useOvalFit({
    container: containerRef,
    top: topBarRef,
    bottom: dockRef,
    // The pose banner sits under the top bar (beside it on a short screen). The floor is the size the oval had before it was measured.
    topReserve: (c) => (c.height <= SHORT_SCREEN ? 56 : c.width >= 640 ? 216 : 200),
    floorShare: (c) => (c.height <= SHORT_SCREEN ? 0.52 : c.width > c.height ? 0.44 : c.width >= 640 ? 0.46 : 0.44),
  });
  // Development only: what the server's detector saw, drawn over the camera.
  const faceDebug = useFaceDebug();
  const { wants: wantsDebug, report: reportDebug } = faceDebug;
  // Read through a ref so toggling sound never changes the capture callback (and so never resets auto-capture timers).
  const soundRef = useRef(true);
  soundRef.current = soundOn;
  useAudioUnlock();
  useEffect(() => preloadVoice(), []);
  const lastRetryVoice = useRef(0);
  const leadIn = useRef<{ key: VoiceKey; at: number } | null>(null);
  // "All done" is only worth saying when this person just finished the last pose, not when an already complete enrollment is reopened.
  const capturedThisSession = useRef(false);
  const busyRef = useRef(false);
  const checkingRef = useRef(false);
  // The first frame that passed the readiness check for the current pose, with the head angles
  // measured on it. Calibration is only committed from it once the server ACCEPTS the sample.
  const readyFrameRef = useRef<{ blob: Blob; pose: string; yaw: number; pitch: number } | null>(null);
  // Readiness checks (and therefore auto-capture) are paused until this time: after a rejected
  // capture, so the same rejected frame isn't resubmitted every few hundred ms, and after a 429.
  const pauseUntilRef = useRef(0);
  // Calibration against THIS employee's own poses, so left/right and
  // up/down are told apart by contrast rather than an absolute guess —
  // see backend app/vision/pose.py for why. baseline = this employee's
  // frontal reading; leftYaw/upPitch = their deviation on the first pose
  // of each pair, required to be in the opposite direction for the second.
  // Kept in sessionStorage too, so refreshing mid-enrollment doesn't lose the calibration the
  // remaining poses are judged against.
  const calibration = useRef<Calibration>(loadCalibration(employee.id));
  const ovalRef = useRef<HTMLDivElement>(null);

  const refreshStatus = useCallback(async () => {
    const res = await api.get<EnrollmentStatus>("/enrollment/status", { params: { target_user_id: employee.id } });
    setStatus(res.data);
    setCaptured(res.data.poses_captured);
    return res.data;
  }, [employee.id]);

  /** Show a banner and, unless sound is off, play the matching chime. */
  const notify = useCallback((n: Notice, opts?: { silent?: boolean }) => {
    setNotice(n);
    if (soundRef.current && !opts?.silent) chime(n.tone === "success");
  }, []);

  useEffect(() => {
    api.get("/enrollment/poses").then((r) => setPoses(r.data.poses)).catch(() => undefined);
    refreshStatus().catch(() => notify({ tone: "error", title: "Couldn't load progress", text: "Check the connection and try again." }));
    start();
  }, [refreshStatus, start, notify]);

  // Banners clear themselves: a success quickly, anything else once there has been time to read it.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), notice.tone === "success" ? SUCCESS_NOTICE_MS : NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else containerRef.current?.requestFullscreen?.();
  }

  const remaining = poses.filter((p) => !captured.includes(p));
  const currentPose = remaining[0];
  const minRequired = status?.min_required ?? 5;
  const count = status?.sample_count ?? 0;
  const allPosesDone = remaining.length === 0;
  const canFinish = count >= minRequired;
  // Biometric consent is recorded once per employee, on their first sample.
  const consentOk = !!status?.consent_recorded || consent;

  // Live readiness preview: polls a cheap quality/pose check a few times a
  // second so the person sees "turn a bit more" / a percentage before any
  // real capture is attempted, instead of the camera firing blind.
  useEffect(() => {
    if (!ready || !currentPose || blocking || allPosesDone) {
      setReadiness(null);
      readyFrameRef.current = null;
      return;
    }
    let cancelled = false;
    readyFrameRef.current = null;
    const base = currentPose!.split("_")[0];
    async function tick() {
      if (cancelled || checkingRef.current || busyRef.current || Date.now() < pauseUntilRef.current) return;
      checkingRef.current = true;
      try {
        const blob = await captureFrame(0.92);
        if (!blob || cancelled) return;
        const form = new FormData();
        form.append("image", blob, "check.jpg");
        form.append("pose", currentPose!);
        const zone = guideZone(videoRef.current, ovalRef.current);
        if (zone) form.append("zone", JSON.stringify(zone));
        const cal = calibration.current;
        if (cal.baselineYaw !== undefined && cal.baselinePitch !== undefined) {
          form.append("baseline_yaw", String(cal.baselineYaw));
          form.append("baseline_pitch", String(cal.baselinePitch));
        }
        if (base === "right" && cal.leftYaw !== undefined) form.append("reference_yaw", String(cal.leftYaw));
        if (base === "down" && cal.upPitch !== undefined) form.append("reference_pitch", String(cal.upPitch));

        if (wantsDebug()) form.append("debug", "1");

        const res = await api.post<{ ready: boolean; score: number; reason: string | null; yaw: number | null; pitch: number | null; debug?: FaceDebug }>("/enrollment/check", form);
        reportDebug(res.data.debug);
        // A check that was already in flight when a capture got rejected (or a 429 arrived) is stale.
        if (cancelled || busyRef.current || Date.now() < pauseUntilRef.current) return;
        setReadiness(res.data);

        if (!res.data.ready) readyFrameRef.current = null;

        // Keep the first frame which actually passes readiness. The sample
        // is submitted from this checked frame, so continued movement during
        // the auto-capture delay cannot turn a valid pose into an extreme one.
        if (res.data.ready && res.data.yaw != null && res.data.pitch != null && !readyFrameRef.current) {
          readyFrameRef.current = { blob, pose: currentPose!, yaw: res.data.yaw, pitch: res.data.pitch };
        }
      } catch (err) {
        if (cancelled || isCancelled(err)) return;
        const wait = retryAfterSeconds(err);
        if (wait !== null) {
          // Rate limited: back off for as long as the server asks instead of hammering it.
          pauseUntilRef.current = Date.now() + wait * 1000;
          readyFrameRef.current = null;
          setReadiness(null);
          setHint({ text: `Too many checks — pausing for ${Math.ceil(wait)} s.`, tone: "warn" });
          notify({ tone: "warn", title: "Please wait a moment", text: `Too many checks. Pausing for ${Math.ceil(wait)} s.` }, { silent: true });
          if (soundRef.current) sayOnce("enroll.wait", RETRY_VOICE_GAP_MS);
        }
        /* other failures are transient — the next tick retries */
      } finally {
        checkingRef.current = false;
      }
    }
    tick();
    const t = setInterval(tick, 350);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [ready, currentPose, blocking, allPosesDone, captureFrame, videoRef, notify, wantsDebug, reportDebug]);

  /** Record calibration from a frame whose sample the server accepted (never from a rejected one). */
  const commitCalibration = useCallback(
    (frame: { pose: string; yaw: number; pitch: number }) => {
      const cal = calibration.current;
      const base = frame.pose.split("_")[0];
      if (base === "frontal" && cal.baselineYaw === undefined) {
        cal.baselineYaw = frame.yaw;
        cal.baselinePitch = frame.pitch;
      } else if (base === "left" && cal.leftYaw === undefined) {
        cal.leftYaw = frame.yaw - (cal.baselineYaw ?? 0);
      } else if (base === "up" && cal.upPitch === undefined) {
        cal.upPitch = frame.pitch - (cal.baselinePitch ?? 0);
      } else {
        return;
      }
      saveCalibration(employee.id, cal);
    },
    [employee.id]
  );

  const capture = useCallback(async () => {
    if (busyRef.current || !currentPose || blocking) return;
    busyRef.current = true;
    setBusy(true);
    const frame = readyFrameRef.current?.pose === currentPose ? readyFrameRef.current : null;
    // Whatever happens, this frame is used at most once.
    readyFrameRef.current = null;
    try {
      const blob = frame?.blob ?? (await captureFrame(0.92));
      if (!blob) return;
      const form = new FormData();
      form.append("image", blob, "capture.jpg");
      form.append("pose", currentPose);
      form.append("target_user_id", employee.id);
      const zone = guideZone(videoRef.current, ovalRef.current);
      if (zone) form.append("zone", JSON.stringify(zone));
      if (consent) form.append("consent", "true");
      const res = await api.post<EnrollmentStatus & { quality_score: number }>("/enrollment/sample", form);
      if (frame) commitCalibration(frame);
      setStatus(res.data);
      setCaptured(res.data.poses_captured);
      setFlash(true);
      setReadiness(null);
      setTimeout(() => setFlash(false), 350);
      capturedThisSession.current = true;
      leadIn.current = { key: "enroll.captured", at: Date.now() };
      const quality = Math.round(res.data.quality_score * 100);
      setHint({ text: `Captured · quality ${quality}%`, tone: "success" });
      notify({ tone: "success", title: "Captured", text: `Quality ${quality}%` });
    } catch (err: any) {
      const code = err?.response?.data?.code;
      const msg = errorMessage(err, "Capture rejected — try again.");
      // Don't let auto-capture resubmit the same rejected frame: wait for fresh readiness checks.
      const wait = retryAfterSeconds(err);
      pauseUntilRef.current = Date.now() + (wait !== null ? wait * 1000 : REJECT_PAUSE_MS);
      setReadiness(null);
      if (code === "DUPLICATE_FACE" || code === "INCONSISTENT_FACE") {
        setBlocking(msg);
        setAuto(false);
        if (soundRef.current) {
          chime(false);
          say("enroll.blocked", 400);
        }
      } else if (wait !== null) {
        setHint({ text: `Too many attempts — pausing for ${Math.ceil(wait)} s.`, tone: "warn" });
        notify({ tone: "warn", title: "Please wait a moment", text: `Too many attempts. Pausing for ${Math.ceil(wait)} s.` });
        if (soundRef.current) sayOnce("enroll.wait", RETRY_VOICE_GAP_MS, 400);
      } else {
        setHint({ text: msg, tone: "warn" });
        notify({ tone: "warn", title: "Not captured", text: msg });
        if (soundRef.current && Date.now() - lastRetryVoice.current > RETRY_VOICE_GAP_MS) {
          lastRetryVoice.current = Date.now();
          say("retry");
        }
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [captureFrame, currentPose, employee.id, blocking, consent, videoRef, commitCalibration, notify]);

  // Auto-capture: only fires once the live readiness check says the pose
  // and quality are good, giving the employee time to get into position
  // instead of the camera snapping the instant a frame arrives. A short
  // pause after a success gives them time to move into the next pose.
  useEffect(() => {
    if (!auto || !ready || !currentPose || blocking || !readiness?.ready || !consentOk || (status?.outdated_samples ?? 0) > 0) return;
    const t = setTimeout(capture, hint?.tone === "success" ? 1400 : AUTO_CAPTURE_INTERVAL_MS);
    return () => clearTimeout(t);
  }, [auto, ready, currentPose, blocking, busy, capture, hint, status?.outdated_samples, readiness?.ready, consentOk]);

  useEffect(() => {
    if (allPosesDone) stop();
  }, [allPosesDone, stop]);

  // Turning the head means looking away from the screen, so each new pose is also spoken, after
  // "Captured." (or "Samples cleared.") when that is what led to it, and after the chime for it.
  const outdatedCount = status?.outdated_samples ?? 0;
  useEffect(() => {
    if (!soundOn || !ready || !currentPose || blocking || !consentOk || outdatedCount > 0) return;
    const lead = leadIn.current && Date.now() - leadIn.current.at < LEAD_IN_MS ? leadIn.current.key : null;
    leadIn.current = null;
    const key = `pose.${currentPose}`;
    if (isVoiceKey(key)) {
      if (lead) say([lead, key], VOICE_AFTER_CHIME_MS);
      else say(key);
    } else speak(POSES[currentPose]?.title ?? "Look at the camera"); // a pose the server added that has no recording yet
    return stopSpeaking;
  }, [soundOn, ready, currentPose, blocking, consentOk, outdatedCount]);

  // The other steps that stop the capture and need someone to act.
  const awaitingConsent = !!status && !consentOk;
  useEffect(() => {
    if (soundOn && awaitingConsent && !blocking) say("enroll.consent");
  }, [soundOn, awaitingConsent, blocking]);

  useEffect(() => {
    if (soundOn && outdatedCount > 0 && !blocking && !awaitingConsent) say("enroll.outdated");
  }, [soundOn, outdatedCount, blocking, awaitingConsent]);

  useEffect(() => {
    if (allPosesDone && capturedThisSession.current && soundRef.current) say("done");
  }, [allPosesDone]);

  async function reset() {
    if (resetting) return;
    setResetting(true);
    try {
      const res = await api.delete<EnrollmentStatus>("/enrollment/samples", { params: { target_user_id: employee.id } });
      setStatus(res.data);
      setCaptured([]);
      calibration.current = {};
      saveCalibration(employee.id, null);
      readyFrameRef.current = null;
      pauseUntilRef.current = 0;
      setBlocking(null);
      setHint(null);
      forgetPhoto(employee.id);
      setConfirmReset(false);
      leadIn.current = { key: "enroll.cleared", at: Date.now() };
      notify({ tone: "success", title: "Samples cleared", text: "Start capturing again." });
      start();
    } catch (err) {
      notify({ tone: "error", title: "Couldn't clear samples", text: errorMessage(err) });
    } finally {
      setResetting(false);
    }
  }

  async function finish() {
    if (finishing) return;
    setFinishing(true);
    try {
      const res = await api.get<User>(`/users/${employee.id}`);
      saveCalibration(employee.id, null);
      forgetPhoto(employee.id);
      onDone(res.data);
    } catch (err) {
      notify({ tone: "error", title: "Couldn't finish enrollment", text: errorMessage(err, "Check the connection and try again. The captured samples are saved.") });
      setFinishing(false);
    }
  }

  const pose = currentPose ? POSES[currentPose] ?? { title: "Look at the camera", hint: "" } : null;
  const poseNumber = Math.min(captured.length + 1, poses.length);

  const needsConsent = !!status && !status.consent_recorded && !consent;
  const outdated = status?.outdated_samples ?? 0;
  // One thing at a time takes over the screen; the banner and controls step aside for it.
  const panelOpen = !!blocking || needsConsent || outdated > 0 || allPosesDone;
  const showBanner = !panelOpen && (!!notice || (ready && !!pose));

  return (
    <div ref={containerRef} className="fixed inset-0 z-40 touch-manipulation select-none overflow-hidden bg-black animate-fade-in">
      <CameraView
        fill
        ovalRef={ovalRef}
        videoRef={videoRef}
        ready={ready && !allPosesDone}
        starting={starting}
        onStart={allPosesDone ? undefined : start}
        tone={blocking || notice?.tone === "error" ? "error" : notice?.tone ?? (busy ? "scanning" : readiness?.ready ? "success" : "idle")}
        scanning={busy}
        isInfrared={isInfrared}
        devices={devices}
        deviceId={deviceId}
        onSwitchCamera={switchCamera}
        toolsClass="right-4 top-24 sm:top-28"
        // Until the real layout has been measured (see useOvalFit), these percentages stand in for it.
        ovalClass="top-[50%] h-[44%] sm:top-[51%] sm:h-[46%] [@media(orientation:landscape)_and_(min-height:521px)]:top-[53%] [@media(orientation:landscape)_and_(min-height:521px)]:h-[44%] [@media(max-height:520px)]:top-[52%] [@media(max-height:520px)]:h-[52%]"
        ovalStyle={ovalStyle}
        overlay={flash ? <div className="absolute inset-0 bg-white/40 animate-fade-in" /> : undefined}
      />
      <FaceDebugOverlay debug={faceDebug} kind="enroll" />

      <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-black/70 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-72 bg-gradient-to-t from-black/70 to-transparent" />

      {/* Top bar: who is being enrolled on the left, window controls on the right */}
      <div ref={topBarRef} className="absolute inset-x-0 top-0 flex items-start justify-between gap-3 px-[max(1rem,env(safe-area-inset-left))] pt-[max(1rem,env(safe-area-inset-top))] sm:px-6 sm:pt-6">
        <div className="flex min-w-0 items-center gap-3 sm:gap-4">
          <Avatar userId={employee.id} name={employee.full_name} hasPhoto={!!status?.has_photo} size="h-12 w-12 sm:h-16 sm:w-16" text="text-base" version={count} ring />
          <div className="min-w-0 drop-shadow">
            <p className="text-xs font-semibold text-brand-400">Enrolling</p>
            <p className="truncate text-xl font-extrabold leading-tight text-white sm:text-3xl">{employee.full_name}</p>
            <p className="truncate text-xs text-neutral-300 sm:text-sm">{[employee.employee_code, employee.department].filter(Boolean).join(" · ")}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button onClick={() => setSoundOn((s) => !s)} className={hudBtn} aria-pressed={soundOn} title={soundOn ? "Sounds and spoken prompts on" : "Sounds and spoken prompts off"} aria-label={soundOn ? "Turn sound off" : "Turn sound on"}>
            <Icon name={soundOn ? "volume" : "volume_off"} className={`h-5 w-5 ${soundOn ? "text-brand-400" : "text-neutral-400"}`} />
            <span className="hidden lg:inline">{soundOn ? "Sound on" : "Sound off"}</span>
          </button>
          <button onClick={toggleFullscreen} className={hudBtn} title="Toggle fullscreen" aria-label="Toggle fullscreen">
            <Icon name="expand" className="h-5 w-5" />
            <span className="hidden lg:inline">{fullscreen ? "Exit fullscreen" : "Fullscreen"}</span>
          </button>
          <button onClick={onBack} className={hudBtn} title="Leave without finishing (captured samples are kept)" aria-label="Back">
            <Icon name="arrow_left" className="h-5 w-5" />
            <span className="hidden md:inline">Back</span>
          </button>
        </div>
      </div>

      {showBanner && <CaptureBanner notice={notice} pose={pose} poseKey={currentPose} poseNumber={poseNumber} poseCount={poses.length} readiness={readiness} />}

      {cameraError && (
        <p role="alert" className="absolute inset-x-4 top-48 mx-auto flex max-w-xl items-center gap-2 rounded-xl border border-red-500/40 bg-black/80 px-4 py-3 text-sm text-red-300">
          <Icon name="alert" className="h-4 w-4 shrink-0" /> {cameraError}
        </p>
      )}

      {/* Control dock: progress, then the big buttons */}
      {!allPosesDone && (
        <div className="absolute inset-x-0 bottom-0 flex justify-center px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-6">
          <div ref={dockRef} className={`${glass} w-full max-w-3xl space-y-3 rounded-3xl p-3 sm:p-4`}>
            <div className="flex items-center gap-3">
              <ol className="flex flex-1 items-center gap-1.5" aria-label="Pose progress">
                {poses.map((p) => (
                  <li
                    key={p}
                    title={POSES[p]?.title ?? p}
                    className={`h-2.5 flex-1 rounded-full transition-colors duration-300 ${captured.includes(p) ? "bg-emerald-400" : p === currentPose ? "bg-brand-400 animate-pulse" : "bg-white/15"}`}
                  />
                ))}
              </ol>
              <span className="shrink-0 text-sm font-semibold tabular-nums text-neutral-100">
                {count} / {minRequired}
                <span className="hidden text-neutral-400 sm:inline"> needed</span>
              </span>
            </div>

            <div className="flex flex-wrap gap-2">
              <button type="button" className={ghostBtn} onClick={() => setConfirmReset(true)} disabled={count === 0 || resetting} aria-label="Start over" title="Delete the captured samples and begin again">
                <Icon name="refresh" className="h-5 w-5" />
                <span className="hidden sm:inline">Start over</span>
              </button>
              {ready && (
                <button
                  type="button"
                  aria-pressed={auto}
                  onClick={() => setAuto((a) => !a)}
                  disabled={!!blocking}
                  className={`${dockBtn} flex-1 border ${auto ? "border-brand-500/50 bg-brand-500/15 text-brand-300" : "border-white/15 bg-white/[0.06] text-neutral-100 hover:bg-white/10"}`}
                >
                  <Icon name={auto ? "bolt" : "pause"} className="h-5 w-5" />
                  {auto ? "Auto-capture on" : "Auto-capture paused"}
                </button>
              )}
              {ready && !auto && (
                <button type="button" onClick={capture} className={`${dockBtn} flex-1 bg-brand-500 text-black hover:bg-brand-400`} disabled={busy || !!blocking || !readiness?.ready || !consentOk}>
                  {busy ? <Spinner /> : <Icon name="camera" className="h-5 w-5" />} {readiness?.ready ? "Capture pose" : "Not ready yet"}
                </button>
              )}
              {canFinish && (
                <button type="button" onClick={finish} disabled={finishing} aria-busy={finishing} className={`${dockBtn} flex-1 bg-emerald-500 text-black hover:bg-emerald-400`}>
                  {finishing ? <Spinner /> : <Icon name="check" className="h-5 w-5" strokeWidth={3} />} Finish
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <CapturePanels
        employee={employee}
        blocking={blocking}
        needsConsent={needsConsent}
        outdated={outdated}
        allPosesDone={allPosesDone}
        count={count}
        canFinish={canFinish}
        finishing={finishing}
        resetting={resetting}
        onDismissBlocking={() => { setBlocking(null); setHint(null); }}
        onConsent={() => setConsent(true)}
        onBack={onBack}
        onReset={reset}
        onFinish={finish}
        onConfirmReset={() => setConfirmReset(true)}
      />

      <ConfirmDialog
        open={confirmReset}
        title="Start over?"
        message={<>This deletes all {count} saved face samples for <b className="text-white">{employee.full_name}</b>. They'll need to be captured again.</>}
        confirmLabel="Delete samples"
        danger
        busy={resetting}
        onConfirm={reset}
        onClose={() => !resetting && setConfirmReset(false)}
      />
    </div>
  );
}
