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

function isInfraredLabel(label: string) {
  return IR_LABEL_RE.test(label);
}

export function useCamera() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [ready, setReady] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [isInfrared, setIsInfrared] = useState(false);
  const preferredDeviceId = useRef<string | null>(null);

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

  const start = useCallback(async () => {
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
        const wanted = preferredDeviceId.current;
        const stream = await navigator.mediaDevices.getUserMedia({
          video: wanted
            ? { deviceId: { exact: wanted }, width: { ideal: 1280 }, height: { ideal: 720 } }
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

        if (!wanted && infrared && infrared.deviceId !== activeId) {
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
          streamRef.current = irStream;
          setDeviceId(infrared.deviceId);
          setIsInfrared(true);
        } else {
          streamRef.current = stream;
          setDeviceId(activeId);
          setIsInfrared(activeDevice ? isInfraredLabel(activeDevice.label) : false);
          preferredDeviceId.current = activeId;
        }

        attach();
        setReady(true);
        setError(null);
      } catch (e: any) {
        if (gen !== generation.current) return;
        setError(
          e?.name === "NotAllowedError"
            ? "Camera permission was denied. Allow camera access in the browser's address bar."
            : e?.name === "NotFoundError"
              ? "No camera was found on this device."
              : e?.name === "NotReadableError"
                ? "The camera is in use by another app or browser tab. Close it and try again."
                : "Could not start the camera. Close other apps using it and try again."
        );
      } finally {
        if (gen === generation.current) setStarting(false);
        pending.current = null;
      }
    })();
    pending.current = run;
    return run;
  }, [attach]);

  const stop = useCallback(() => {
    generation.current += 1;
    pending.current = null;
    setStarting(false);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setReady(false);
  }, []);

  // Re-attach if the <video> element re-mounts (e.g. after a layout change).
  useEffect(() => {
    if (ready) attach();
  });

  const captureFrame = useCallback((quality = 0.85, maxWidth = CAPTURE_WIDTH): Promise<Blob | null> => {
    return new Promise((resolve) => {
      const video = videoRef.current;
      if (!video || !video.videoWidth) return resolve(null);
      const scale = Math.min(1, maxWidth / video.videoWidth);
      const canvas = (canvasRef.current ??= document.createElement("canvas"));
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);
      const ctx = canvas.getContext("2d");
      if (!ctx) return resolve(null);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => resolve(blob), "image/jpeg", quality);
    });
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
      generation.current += 1;
      pending.current = null;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setReady(false);
      start();
    },
    [start]
  );

  useEffect(() => stop, [stop]);

  return { videoRef, ready, starting, error, start, stop, captureFrame, captureBurst, devices, deviceId, isInfrared, switchCamera };
}
