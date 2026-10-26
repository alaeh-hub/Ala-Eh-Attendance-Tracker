import { useEffect, useState } from "react";
import { formatDate, formatTime, orgNow, orgParts, useOrgStore } from "../utils/orgTime";

function greet(hour: number) {
  if (hour < 5) return "Burning the midnight oil";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/**
 * Full-screen idle overlay shown after a stretch of no activity (see
 * useIdle). Doubles as a lightweight privacy screen for a shared office
 * computer and tells the next person at a glance it's just resting, not
 * frozen. Any key/click/touch dismisses it instantly via useIdle's own
 * activity listeners, so this component needs no dismiss handler itself.
 */
export default function IdleScreen({ hint = "Move, tap, or press a key to continue" }: { hint?: string }) {
  const [now, setNow] = useState(orgNow);
  useOrgStore((s) => s.timeZone); // re-render when the org timezone arrives
  useEffect(() => {
    const t = setInterval(() => setNow(orgNow()), 1000 * 15);
    return () => clearInterval(t);
  }, []);

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col items-center justify-center overflow-hidden bg-ink-950 animate-fade-in"
      role="status"
      aria-label={`Idle. ${hint}.`}
    >
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-[1000px] w-[1000px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand-500/10 blur-[120px]" />

      <div className="relative flex flex-col items-center text-center animate-scale-in">
        <div className="relative mb-10">
          <span className="absolute inset-0 rounded-full bg-brand-500/30 blur-2xl" />
          <img src="/logo.png" alt="Ala Eh! Food Products" className="relative h-40 w-40 rounded-full shadow-glow sm:h-56 sm:w-56" />
        </div>
        <p className="text-3xl font-semibold text-brand-400 sm:text-5xl">
          {greet(orgParts(now).hour)}
          <span className="text-brand-300">.</span>
        </p>
        <p className="mt-4 text-[clamp(5.5rem,17vw,15rem)] font-extrabold leading-none tabular-nums tracking-tight text-white">
          {formatTime(now.toISOString())}
        </p>
        <p className="mt-5 text-2xl text-neutral-300 sm:text-4xl">{formatDate(now, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</p>
        <p className="mt-16 text-base font-semibold uppercase tracking-[0.2em] text-neutral-400 sm:text-2xl">{hint}</p>
      </div>
    </div>
  );
}
