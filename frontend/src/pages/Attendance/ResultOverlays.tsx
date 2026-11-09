import Icon from "../../components/Icon";
import { Avatar, EventBadge, formatTime } from "../../components/ui";
import type { Phase } from "./kioskOutcome";

/** Full-screen confirmation of a recorded punch. */
export function SuccessOverlay({ phase }: { phase: Extract<Phase, { kind: "success" }> }) {
  const { event, note, reverifySeconds } = phase;
  const isIn = event.event_type === "CLOCK_IN";
  return (
    <div className="absolute inset-0 flex overflow-y-auto bg-black/70 p-4 animate-fade-in">
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
        <p className="text-sm font-semibold text-brand-400">{isIn ? "Good day" : "See you"}</p>
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

/** A bottom banner for anything that is not a recorded punch (already recorded, verified, errors). */
export function NoticeOverlay({ phase }: { phase: Extract<Phase, { kind: "notice" }> }) {
  const isError = phase.tone === "error";
  return (
    <div className="absolute inset-x-0 bottom-0 p-4 pb-[max(1rem,env(safe-area-inset-bottom))] animate-fade-up">
      <div className={`flex items-center gap-4 rounded-2xl border bg-black/80 p-4 ${isError ? "border-red-500/40" : "border-orange-400/40"}`}>
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
