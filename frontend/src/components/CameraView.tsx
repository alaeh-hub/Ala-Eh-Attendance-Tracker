import { CSSProperties, ReactNode, RefObject } from "react";
import Icon from "./Icon";
import { Spinner } from "./ui";

export type CameraTone = "idle" | "scanning" | "success" | "warn" | "error";

const TONE_RING: Record<CameraTone, string> = {
  idle: "border-white/25",
  scanning: "border-brand-400",
  success: "border-emerald-400",
  warn: "border-orange-400",
  error: "border-red-400",
};

export default function CameraView({
  videoRef,
  ready,
  starting,
  onStart,
  tone = "idle",
  scanning = false,
  overlay,
  aspect = "aspect-[4/3]",
  guideLabel,
  isInfrared = false,
  devices,
  deviceId,
  onSwitchCamera,
  allowCameraSwitch = true,
  fill = false,
  toolsClass = "right-3 top-3",
  ovalClass = "top-[45%] h-[74%]",
  ovalStyle,
  ovalRef,
}: {
  videoRef: RefObject<HTMLVideoElement>;
  ready: boolean;
  starting?: boolean;
  onStart?: () => void;
  tone?: CameraTone;
  scanning?: boolean;
  overlay?: ReactNode;
  aspect?: string;
  guideLabel?: string;
  /** True when the active video source is an IR sensor rather than regular RGB. */
  isInfrared?: boolean;
  /** Available video inputs; pass alongside deviceId/onSwitchCamera to show a picker when there's more than one. */
  devices?: MediaDeviceInfo[];
  deviceId?: string | null;
  onSwitchCamera?: (id: string) => void;
  /** False hides the camera picker (the kiosk: passers-by must not be able to change the camera). */
  allowCameraSwitch?: boolean;
  /** Cover the whole parent (no frame, no rounded corners) instead of using `aspect`. */
  fill?: boolean;
  /** Where the IR badge / camera picker sit. */
  toolsClass?: string;
  /** Position and height of the face window (a Tailwind class string; supports responsive variants). */
  ovalClass?: string;
  /** A measured `top` (the oval's centre) and `height` in px, which win over those in `ovalClass`; see useOvalFit. */
  ovalStyle?: CSSProperties;
  /** Lets the kiosk measure where the face window is, to tell the server which part of the frame to scan. */
  ovalRef?: RefObject<HTMLDivElement>;
}) {
  const showPicker = allowCameraSwitch && !!devices && devices.length > 1 && !!onSwitchCamera;
  return (
    <div className={fill ? "absolute inset-0 overflow-hidden bg-black" : `relative w-full overflow-hidden rounded-2xl border border-white/10 bg-black ${aspect}`}>
      {/* Mirrored so moving left moves left on screen, like a mirror */}
      <video ref={videoRef} autoPlay muted playsInline className={`h-full w-full -scale-x-100 object-cover transition-opacity duration-500 ${ready ? "opacity-100" : "opacity-0"}`} />

      {ready && (isInfrared || showPicker) && (
        <div className={`absolute z-10 flex items-center gap-2 ${toolsClass}`}>
          {isInfrared && (
            <span className="rounded-full border border-sky-400/30 bg-black/70 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-sky-300 backdrop-blur" title="Using the infrared sensor for capture">
              IR
            </span>
          )}
          {showPicker && (
            <select
              value={deviceId ?? ""}
              onChange={(e) => onSwitchCamera!(e.target.value)}
              aria-label="Choose camera"
              className="rounded-full border border-white/10 bg-black/70 px-2.5 py-1 text-[11px] font-medium text-neutral-200 backdrop-blur"
              title="Choose camera"
            >
              {devices!.map((d, i) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label || `Camera ${i + 1}`}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {ready && (
        <div className="pointer-events-none absolute inset-0">
          {/* Vignette with an oval face window */}
          {/* Dims everything outside the face window; shares the window's own shape so the two always line up. */}
          {!fill && (
            <div
              className={`absolute left-1/2 ${ovalClass} w-auto -translate-x-1/2 -translate-y-1/2 rounded-[50%] shadow-[0_0_0_9999px_rgba(0,0,0,.5)]`}
              style={{ aspectRatio: "0.78", ...ovalStyle }}
            />
          )}
          <div
            ref={ovalRef}
            className={`absolute left-1/2 ${ovalClass} w-auto -translate-x-1/2 -translate-y-1/2 rounded-[50%] border-[3px] transition-colors duration-300 ${TONE_RING[tone]} ${scanning ? "shadow-[0_0_60px_-6px_rgba(245,192,0,.6)]" : ""
              }`}
            style={{ aspectRatio: "0.78", ...ovalStyle }}
          >
            {scanning && (
              <div className="absolute inset-0 overflow-hidden rounded-[50%]">
                <div className="absolute left-0 right-0 h-[2px] animate-scan bg-gradient-to-r from-transparent via-brand-300 to-transparent shadow-[0_0_18px_4px_rgba(245,192,0,.55)]" />
              </div>
            )}
          </div>
          {/* Corner brackets */}
          {!fill && ["left-4 top-4 border-l-2 border-t-2 rounded-tl-xl", "right-4 top-4 border-r-2 border-t-2 rounded-tr-xl", "left-4 bottom-4 border-l-2 border-b-2 rounded-bl-xl", "right-4 bottom-4 border-r-2 border-b-2 rounded-br-xl"].map((c) => (
            <span key={c} className={`absolute h-8 w-8 border-brand-500/80 ${c}`} />
          ))}
          {guideLabel && (
            <div className="absolute inset-x-0 bottom-5 flex justify-center px-4">
              <span key={guideLabel} className="rounded-full border border-white/10 bg-black/75 px-5 py-2 text-sm font-semibold text-white backdrop-blur animate-fade-up sm:text-base">{guideLabel}</span>
            </div>
          )}
        </div>
      )}

      {!ready && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-[radial-gradient(circle_at_50%_40%,rgba(245,192,0,.08),transparent_60%)]">
          <span className="relative flex h-20 w-20 items-center justify-center">
            <span className="absolute inset-0 rounded-full bg-brand-500/20 animate-pulse-ring" />
            <span className="relative rounded-full border border-brand-500/40 bg-ink-850 p-5 text-brand-400">
              <Icon name="camera" className="h-8 w-8" />
            </span>
          </span>
          {onStart && (
            <button className="btn-primary" onClick={onStart} disabled={starting}>
              {starting ? <Spinner /> : <Icon name="play" className="h-4 w-4" />}
              {starting ? "Starting camera..." : "Start camera"}
            </button>
          )}
        </div>
      )}

      {overlay}
    </div>
  );
}