import { useCallback, useEffect, useRef, useState } from "react";

// Keep more source detail for YuNet/SFace alignment while bounding kiosk burst
// uploads; camera frames above this width are reduced before JPEG encoding.
const CAPTURE_WIDTH = 960;

// Windows Hello and similar kiosks expose an IR sensor as its own
// "videoinput" device, separate from the regular RGB webcam, labeled things
// like "IR Camera" or "Infrared". IR is unaffected by backlight/low light
// and can't be fooled by a printed photo the way RGB can, so we prefer it
// automatically whenever the hardware offers one.
const IR_LABEL_RE = /\b(ir|infrared)\b/i;

// Self-healing: a camera that is unplugged, grabbed by another app, or whose
// driver stalls (frames stop arriving while the track still says "live") is
// stopped and restarted, with backoff, so a kiosk recovers without a reload.
const WATCHDOG_INTERVAL_MS = 1000;
const STALL_MS = 5000;
const RESTART_BASE_MS = 1000;
const RESTART_MAX_MS = 30_000;

export const INSECURE_CONTEXT_ERROR =
  "Camera needs HTTPS. Open this page over https:// (or on localhost); browsers block the camera on plain http.";

function isInfraredLabel(label: string) {
  return IR_LABEL_RE.test(label);
}

function cameraSupported() {
  return typeof window !== "undefined" && window.isSecureContext === true && typeof navigator.mediaDevices?.getUserMedia === "function";
}

function describeError(e: any): string {
  return e?.name === "NotAllowedError"
    ? "Camera permission was denied. Allow camera access in the browser's address bar."
    : e?.name === "NotFoundError" || e?.name === "OverconstrainedError"
      ? "No camera was found on this device."
      : e?.name === "NotReadableError"
        ? "The camera is in use by another app or browser tab. Close it and try again."
        : "Could not start the camera. Close other apps using it and try again.";
}

/**
 * Mean absolute difference (0-255) between two equally sized grayscale
 * thumbnails; Infinity when they can't be compared. Used to skip presence
 * checks when the picture hasn't changed.
 */
export function frameDifference(a: Uint8ClampedArray | null, b: Uint8ClampedArray | null): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

export function useCamera() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const thumbCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [ready, setReady] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [isInfrared, setIsInfrared] = useState(false);
  const preferredDeviceId = useRef<string | null>(null);
  // True between start() and stop(): the camera should be running, so failures are retried.
  const wanted = useRef(false);
  const restartTimer = useRef<ReturnType<typeof setTimeout>>();
  const restartAttempts = useRef(0);

  const attach = useCallback(() => {
    const video = videoRef.current;
    if (video && streamRef.current && video.srcObject !== streamRef.current) {
      video.srcObject = streamRef.current;
      video.play().catch(() => undefined);
    }
  }, []);

  // Bumped by stop(); a getUserMedia that resolves after a stop (or after a
  // newer start) is discarded, so no stream leaks and the webcam light goes off.
  const generation = useRef(0);
  const pending = useRef<Promise<void> | null>(null);
  const startRef = useRef<() => Promise<void>>();

  /** Stops the current stream (if any) without giving up on the camera. */
  const dropStream = useCallback(() => {
    generation.current += 1;
    pending.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setReady(false);
    setStarting(false);
  }, []);

  /** Stop, then start again after a growing delay. */
  const scheduleRestart = useCallback(() => {
    if (!wanted.current) return;
    dropStream();
    clearTimeout(restartTimer.current);
    const delay = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** Math.min(restartAttempts.current, 5));
    restartAttempts.current += 1;
    restartTimer.current = setTimeout(() => {
      if (wanted.current) startRef.current?.();
    }, delay);
  }, [dropStream]);

  const adoptStream = useCallback(
    (stream: MediaStream) => {
      streamRef.current = stream;
      const gen = generation.current;
      stream.getVideoTracks().forEach((track) =>
        track.addEventListener("ended", () => {
          // Unplugged, or the OS took the camera away.
          if (gen === generation.current && streamRef.current === stream) scheduleRestart();
        })
      );
    },
    [scheduleRestart]
  );

  const start = useCallback(async () => {
    wanted.current = true;
    clearTimeout(restartTimer.current);
    if (!cameraSupported()) {
      setError(INSECURE_CONTEXT_ERROR);
      setReady(false);
      return;
    }
    if (streamRef.current) {
      attach();
      setReady(true);
      return;
    }
    if (pending.current) return pending.current;
    const gen = generation.current;
    setStarting(true);
    const run = (async () => {
      try {
        const want = preferredDeviceId.current;
        const stream = await navigator.mediaDevices.getUserMedia({
          video: want
            ? { deviceId: { exact: want }, width: { ideal: 1280 }, height: { ideal: 720 } }
            : { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (gen !== generation.current) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        // Labels are only populated once permission has been granted, so the
        // very first call can't know an IR device exists ahead of time — this
        // enumeration runs after that first grant and, if it finds one and we
        // aren't already on it, swaps the stream over transparently.
        const list = await navigator.mediaDevices.enumerateDevices();
        const videoInputs = list.filter((d) => d.kind === "videoinput");
        if (gen === generation.current) setDevices(videoInputs);

        const activeId = stream.getVideoTracks()[0]?.getSettings().deviceId ?? null;
        const activeDevice = videoInputs.find((d) => d.deviceId === activeId);
        const infrared = videoInputs.find((d) => isInfraredLabel(d.label));

        if (!want && infrared && infrared.deviceId !== activeId) {
          stream.getTracks().forEach((t) => t.stop());
          preferredDeviceId.current = infrared.deviceId;
          const irStream = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: { exact: infrared.deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: false,
          });
          if (gen !== generation.current) {
            irStream.getTracks().forEach((t) => t.stop());
            return;
          }
          adoptStream(irStream);
          setDeviceId(infrared.deviceId);
          setIsInfrared(true);
        } else {
          adoptStream(stream);
          setDeviceId(activeId);
          setIsInfrared(activeDevice ? isInfraredLabel(activeDevice.label) : false);
          preferredDeviceId.current = activeId;
        }

        attach();
        setReady(true);
        setError(null);
      } catch (e: any) {
        if (gen !== generation.current) return;
        setError(describeError(e));
        // The preferred device may be gone for good: fall back to any camera next time.
        if (e?.name === "OverconstrainedError" || e?.name === "NotFoundError") preferredDeviceId.current = null;
        // Permission problems need a person; anything else (unplugged, busy) is retried.
        if (e?.name !== "NotAllowedError" && e?.name !== "SecurityError") {
          pending.current = null;
          setStarting(false);
          scheduleRestart();
        }
      } finally {
        if (gen === generation.current) {
          setStarting(false);
          pending.current = null;
        }
      }
    })();
    pending.current = run;
    return run;
  }, [attach, scheduleRestart, adoptStream]);
  startRef.current = start;

  const stop = useCallback(() => {
    wanted.current = false;
    clearTimeout(restartTimer.current);
    restartAttempts.current = 0;
    dropStream();
  }, [dropStream]);

  // Re-attach if the <video> element re-mounts (e.g. after a layout change).
  useEffect(() => {
    if (ready) attach();
  });

  // Watchdog: the track must stay "live" and the video must keep advancing.
  useEffect(() => {
    if (!ready) return;
    let lastTime = -1;
    let lastAdvance = Date.now();
    const t = setInterval(() => {
      const track = streamRef.current?.getVideoTracks()[0];
      const video = videoRef.current;
      if (!track || track.readyState !== "live") {
        scheduleRestart();
        return;
      }
      if (!video || document.hidden) {
        lastAdvance = Date.now();
        return;
      }
      if (video.paused) video.play().catch(() => undefined);
      if (video.currentTime !== lastTime) {
        lastTime = video.currentTime;
        lastAdvance = Date.now();
        // Running smoothly again: the next failure starts the backoff from the beginning.
        if (lastTime > 0) restartAttempts.current = 0;
      } else if (Date.now() - lastAdvance > STALL_MS) {
        scheduleRestart();
      }
    }, WATCHDOG_INTERVAL_MS);
    return () => clearInterval(t);
  }, [ready, scheduleRestart]);

  // A camera plugged in or removed: refresh the list, and recover if ours vanished.
  useEffect(() => {
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    if (!md?.addEventListener) return;
    const onChange = async () => {
      let inputs: MediaDeviceInfo[] = [];
      try {
        inputs = (await md.enumerateDevices()).filter((d) => d.kind === "videoinput");
      } catch {
        return;
      }
      setDevices(inputs);
      if (!wanted.current) return;
      const track = streamRef.current?.getVideoTracks()[0];
      if (!track || track.readyState !== "live") {
        restartAttempts.current = 0;
        scheduleRestart();
      }
    };
    md.addEventListener("devicechange", onChange);
    return () => md.removeEventListener("devicechange", onChange);
  }, [scheduleRestart]);

  const captureFrame = useCallback((quality = 0.85, maxWidth = CAPTURE_WIDTH): Promise<Blob | null> => {
    return new Promise((resolve) => {
      const video = videoRef.current;
      if (!video || !video.videoWidth) return resolve(null);
      const scale = Math.min(1, maxWidth / video.videoWidth);
      const width = Math.round(video.videoWidth * scale);
      const height = Math.round(video.videoHeight * scale);
      const canvas = (canvasRef.current ??= document.createElement("canvas"));
      // Assigning a size, even the same one, clears the canvas and reallocates it.
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      // Every capture reads the picture straight back out as a JPEG. A canvas made for frequent readback
      // (CPU-backed) does that in a few ms; the default GPU-backed one stalls on every readback (measured:
      // ~1300 ms against ~25 ms for the same capture). The option only takes effect on a canvas' first getContext.
      const ctx = canvas.getContext("2d", { willReadFrequently: true } as CanvasRenderingContext2DSettings);
      if (!ctx) return resolve(null);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality);
    });
  }, []);

  /** A tiny grayscale thumbnail of the current frame, for cheap change detection. */
  const sampleThumbnail = useCallback((width = 32, height = 24): Uint8ClampedArray | null => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return null;
    const canvas = (thumbCanvasRef.current ??= document.createElement("canvas"));
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true } as CanvasRenderingContext2DSettings);
    if (!ctx) return null;
    try {
      ctx.drawImage(video, 0, 0, width, height);
      const rgba = ctx.getImageData(0, 0, width, height).data;
      const gray = new Uint8ClampedArray(width * height);
      for (let i = 0; i < gray.length; i++) gray[i] = (rgba[i * 4] * 299 + rgba[i * 4 + 1] * 587 + rgba[i * 4 + 2] * 114) / 1000;
      return gray;
    } catch {
      return null;
    }
  }, []);

  // Short burst of frames used for blink liveness + multi-frame recognition.
  const captureBurst = useCallback(
    async (count = 8, intervalMs = 110): Promise<Blob[]> => {
      const frames: Blob[] = [];
      for (let i = 0; i < count; i++) {
        const started = performance.now();
        const frame = await captureFrame(0.8);
        if (frame) frames.push(frame);
        const wait = intervalMs - (performance.now() - started);
        if (i < count - 1 && wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
      return frames;
    },
    [captureFrame]
  );

  // Lets a kiosk operator manually pick a different video input (e.g. force
  // RGB over IR, or pick between two IR sensors) instead of the automatic
  // choice made in start().
  const switchCamera = useCallback(
    (id: string) => {
      preferredDeviceId.current = id;
      restartAttempts.current = 0;
      dropStream();
      start();
    },
    [dropStream, start]
  );

  useEffect(() => stop, [stop]);

  return { videoRef, ready, starting, error, start, stop, captureFrame, captureBurst, sampleThumbnail, devices, deviceId, isInfrared, switchCamera };
}
