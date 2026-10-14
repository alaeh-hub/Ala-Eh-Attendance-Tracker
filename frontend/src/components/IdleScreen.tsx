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
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-[640px] w-[640px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand-500/10 blur-[120px]" />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(255,255,255,.025)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.025)_1px,transparent_1px)] bg-[size:48px_48px] [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_75%)]" />

      <div className="relative flex flex-col items-center text-center animate-scale-in">
        <div className="relative mb-6">
          <span className="absolute inset-0 rounded-full bg-brand-500/30 blur-2xl" />
          <img src="/logo.png" alt="Ala Eh! Food Products" className="relative h-24 w-24 rounded-full shadow-glow" />
        </div>
        <p className="text-lg font-semibold text-brand-400">
          {greet(orgParts(now).hour)}
          <span className="text-brand-300">.</span>
        </p>
        <p className="mt-2 text-6xl font-extrabold tabular-nums tracking-tight text-white sm:text-7xl">
          {formatTime(now.toISOString())}
        </p>
        <p className="mt-2 text-base text-neutral-400">{formatDate(now, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}</p>
        <p className="mt-10 text-xs font-semibold uppercase tracking-[0.2em] text-neutral-500">{hint}</p>
      </div>
    </div>
  );
}
