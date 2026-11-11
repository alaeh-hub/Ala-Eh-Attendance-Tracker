import { useEffect, useState } from "react";
import { animate } from "motion";
import { AsciiImage } from "./fx/AsciiImage";
import { Constellation } from "./fx/Constellation";
import { motionOK } from "../lib/motion";
import { formatDate, formatTime, orgNow, orgParts, useOrgStore } from "../utils/orgTime";

function greet(hour: number) {
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

const DIM_AFTER_MS = 3 * 60_000; // an always-on screen eases down after a few quiet minutes
const DRIFT_EVERY_MS = 25_000; // and the picture wanders a little, so nothing sits on the same pixels all night
const DRIFT_PX = 22;

/**
 * Full-screen idle overlay shown after a stretch of no activity (see useIdle). On the admin side it doubles as a privacy
 * screen for a shared computer; on the kiosk it is the resting face of a tablet that stays on all day, so it also guards
 * the panel against burn-in. Any key, click or touch dismisses it instantly through useIdle's own listeners, so this
 * component needs no dismiss handler.
 */
export default function IdleScreen({
  hint = "Move, tap, or press a key to continue",
  variant = "admin",
}: {
  hint?: string;
  variant?: "admin" | "kiosk";
}) {
  const [now, setNow] = useState(orgNow);
  const [dim, setDim] = useState(false);
  const [drift, setDrift] = useState<HTMLDivElement | null>(null);
  useOrgStore((s) => s.timeZone); // re-render when the org timezone arrives

  useEffect(() => {
    const t = setInterval(() => setNow(orgNow()), 1000 * 15);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const t = setTimeout(() => setDim(true), DIM_AFTER_MS);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => {
    if (!drift || !motionOK()) return;
    const move = () =>
      animate(
        drift,
        { x: (Math.random() * 2 - 1) * DRIFT_PX, y: (Math.random() * 2 - 1) * DRIFT_PX },
        { duration: 6, ease: "easeInOut" }
      );
    const t = setInterval(move, DRIFT_EVERY_MS);
    return () => clearInterval(t);
  }, [drift]);

  const [clock, period] = formatTime(now.toISOString()).split(/\s+/);
  const [hh, mm] = clock.split(":");

  return (
    <div
      className="ascii-crt is-revealed idle-screen fixed inset-0 z-[800] flex flex-col items-center justify-center overflow-hidden animate-fade-in"
      style={{ filter: dim ? "brightness(0.78)" : undefined }}
      role="status"
      aria-label={`Idle. ${hint}.`}
    >
      {/* Livelier than the in-app background: nothing competes with it here. Sits under the scan lines, over the paper. */}
      <Constellation className="absolute inset-0 z-[1]" intensity={3.5} />
      <div ref={setDrift} className="relative z-[3] flex w-full flex-col items-center px-6 text-center">
        <div className="w-[min(34vh,300px)]">
          <AsciiImage src="/logo.png" cols={64} label="Ala Eh! Food Products" className="ascii-glow" />
        </div>

        <p className="idle-mono mt-8 text-lg uppercase tracking-[0.2em] text-neutral-200 sm:text-2xl">
          {variant === "kiosk" ? "Attendance kiosk" : greet(orgParts(now).hour)}
        </p>

        <p
          className="mt-2 flex items-baseline justify-center font-display font-bold leading-none tabular-nums tracking-tight text-white"
          style={{ fontSize: "clamp(5rem, 16vw, 14rem)" }}
          aria-label={`${clock} ${period ?? ""}`.trim()}
        >
          <span>{hh}</span>
          <span className="idle-colon text-brand-400" aria-hidden="true">
            :
          </span>
          <span>{mm}</span>
          {period && <span className="idle-mono ml-4 text-[0.22em] font-medium text-neutral-200">{period}</span>}
        </p>

        <p className="idle-mono mt-6 text-xl text-neutral-100 sm:text-3xl">
          {formatDate(now, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
        </p>

        <p className="idle-mono mt-14 inline-flex items-center gap-4 rounded-full border border-brand-400/60 bg-black/40 px-7 py-4 text-xl font-medium text-white shadow-[0_0_32px_-8px_var(--color-accent)] sm:text-3xl">
          <span className="relative flex h-3.5 w-3.5" aria-hidden="true">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-400 opacity-70" />
            <span className="relative inline-flex h-3.5 w-3.5 rounded-full bg-brand-400" />
          </span>
          {hint}
        </p>
        {variant === "admin" && <p className="idle-mono mt-5 text-base text-neutral-300">Locked for privacy</p>}
      </div>
    </div>
  );
}
