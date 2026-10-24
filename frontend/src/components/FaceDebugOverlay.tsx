import { useEffect, useState } from "react";
import { FaceDebugControls, LANDMARK_COLORS, LANDMARK_NAMES, debugLines, detectionLines, matchLines, useFaceDebugReadings } from "../utils/faceDebug";

// A reading older than this is drawn faded: the camera has moved on since.
const STALE_MS = 2500;
// Boxes and landmarks glide to their new place over about one reading interval, so a live feed looks continuous
// (short, so the glide adds as little lag as possible).
const GLIDE = "transform 140ms linear";

/**
 * Development-only: draws what the server's face detector saw over the camera picture (every face
 * box, the five landmarks, the guide oval and the zone the server accepts) with a readout of the
 * numbers. It is a sibling of the camera and covers the same area, so the SVG's "slice" fit crops
 * the frame exactly the way the video's object-cover does; it is mirrored like the video.
 */
export default function FaceDebugOverlay({ debug, kind }: { debug: FaceDebugControls; kind: "enroll" | "scan" }) {
  const { available, on, toggle } = debug;
  // Subscribed here, not in the screen: a live feed delivers several readings a second.
  const { data, scan, at, missing } = useFaceDebugReadings();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!available || !on) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [available, on]);

  if (!available) return null;

  const age = data ? Math.max(0, now - at) : 0;
  const stale = age > STALE_MS;
  const unit = data ? Math.max(data.image.w, data.image.h) : 1;
  // A live reading has no match numbers of its own: keep showing the last scan's underneath.
  const lines = data ? (data.live ? detectionLines(data) : debugLines(data)) : [];
  const lastScan = data?.live && scan ? matchLines(scan) : [];

  return (
    <>
      {on && data && (
        <svg
          data-testid="face-debug-shapes"
          className="pointer-events-none absolute inset-0 h-full w-full -scale-x-100 transition-opacity duration-300"
          style={{ opacity: stale ? 0.3 : 1 }}
          viewBox={`0 0 ${data.image.w} ${data.image.h}`}
          preserveAspectRatio="xMidYMid slice"
          aria-hidden="true"
        >
          {data.zone && (
            <>
              <ellipse cx={data.zone.cx * data.image.w} cy={data.zone.cy * data.image.h} rx={data.zone.rx * data.image.w} ry={data.zone.ry * data.image.h} fill="none" stroke="#22d3ee" strokeWidth={2} vectorEffect="non-scaling-stroke" />
              <ellipse
                cx={data.zone.cx * data.image.w}
                cy={data.zone.cy * data.image.h}
                rx={data.zone.rx * data.zone.margin * data.image.w}
                ry={data.zone.ry * data.zone.margin * data.image.h}
                fill="none"
                stroke="#22d3ee"
                strokeWidth={1.5}
                strokeDasharray="6 6"
                opacity={0.7}
                vectorEffect="non-scaling-stroke"
              />
            </>
          )}
          {data.faces.map((f, i) => {
            const [left, top, right, bottom] = f.box;
            const colour = f.chosen ? "#4ade80" : "#fb923c";
            return (
              <g key={i}>
                <rect
                  x={0}
                  y={0}
                  width={right - left}
                  height={bottom - top}
                  fill="none"
                  stroke={colour}
                  strokeWidth={2}
                  strokeDasharray={f.chosen ? undefined : "8 5"}
                  vectorEffect="non-scaling-stroke"
                  style={{ transform: `translate(${left}px, ${top}px)`, transition: GLIDE }}
                />
                {f.landmarks?.map(([x, y], n) => (
                  <circle
                    key={n}
                    cx={0}
                    cy={0}
                    r={unit * 0.007}
                    fill={LANDMARK_COLORS[n] ?? "#fff"}
                    stroke="#000"
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                    style={{ transform: `translate(${x}px, ${y}px)`, transition: GLIDE }}
                  />
                ))}
              </g>
            );
          })}
        </svg>
      )}

      {/* Under the screen's own banner (the pose card / the prompt pill), so it never covers it. */}
      <div
        className={`pointer-events-none absolute left-2 z-[5] w-52 max-w-[46vw] font-mono text-[10px] leading-4 text-white/90 [@media(max-height:520px)]:top-16 ${
          kind === "enroll" ? "top-[13.5rem] sm:top-[14.5rem]" : "top-[10rem] sm:top-[10.75rem]"
        }`}
      >
        <div className="pointer-events-auto flex items-center justify-between gap-2 rounded-t-lg border border-white/10 bg-black/70 px-2 py-1 backdrop-blur">
          <span className="font-bold uppercase tracking-wider text-cyan-300">Debug · {kind === "enroll" ? "enroll" : "scan"}</span>
          <button type="button" onClick={toggle} aria-pressed={on} className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase hover:bg-white/20">
            {on ? "Hide" : "Show"}
          </button>
        </div>
        {on && (
          <div className="rounded-b-lg border border-t-0 border-white/10 bg-black/60 px-2 py-1.5 backdrop-blur" aria-live="off">
            {data ? (
              <>
                {lines.map((line, i) => (
                  <p key={i} className={line.includes("NO") || line.includes("none used") || (line.startsWith("server:") && !line.endsWith("face ok")) ? "text-orange-300" : undefined}>
                    {line}
                  </p>
                ))}
                <p className={stale ? "text-orange-300" : "text-neutral-400"}>age {(age / 1000).toFixed(1)}s{stale ? " (stale)" : ""}</p>
                {lastScan.length > 0 && (
                  <div className="mt-1 border-t border-white/10 pt-1">
                    <p className="text-cyan-300">last scan</p>
                    {lastScan.map((line, i) => (
                      <p key={i}>{line}</p>
                    ))}
                  </div>
                )}
                <p className="mt-1 flex flex-wrap gap-x-2 [@media(max-height:520px)]:hidden">
                  {LANDMARK_NAMES.map((name, n) => (
                    <span key={name} className="inline-flex items-center gap-1">
                      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: LANDMARK_COLORS[n] }} />
                      {name}
                    </span>
                  ))}
                </p>
                <p className="mt-1 text-neutral-400 [@media(max-height:520px)]:hidden">
                  <span className="text-green-400">━</span> used <span className="text-orange-400">┅</span> ignored <span className="text-cyan-300">◯</span> oval / zone
                </p>
              </>
            ) : missing ? (
              <p className="text-orange-300">The server sent no debug data. It must not be in production mode (APP_ENV).</p>
            ) : (
              <p className="text-neutral-400">Waiting for the first {kind === "enroll" ? "check" : "scan"}…</p>
            )}
          </div>
        )}
      </div>
    </>
  );
}
