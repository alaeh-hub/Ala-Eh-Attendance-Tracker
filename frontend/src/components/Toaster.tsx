import { AnimatePresence, motion } from "motion/react";
import { motionOK } from "../lib/motion";
import { toastMs, useToastStore } from "../stores/toastStore";
import Icon from "./Icon";

const TONES = {
  success: { icon: "check" as const, cls: "border-emerald-500/30 text-emerald-300", dot: "bg-emerald-500/15" },
  error: { icon: "x_circle" as const, cls: "border-red-500/30 text-red-300", dot: "bg-red-500/15" },
  info: { icon: "info" as const, cls: "border-brand-500/30 text-brand-300", dot: "bg-brand-500/15" },
};

/**
 * Toasts sit top-centre on phones (clear of the notch) and top-right from `sm` up.
 * On touch they can be flicked sideways to dismiss; the close button stays for mouse and keyboard.
 */
export default function Toaster() {
  const { toasts, dismiss } = useToastStore();
  const animated = motionOK();
  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-[max(0.75rem,env(safe-area-inset-top))] z-[var(--z-toast)] mx-auto flex w-[min(92vw,380px)] flex-col gap-2 sm:inset-x-auto sm:right-4 sm:top-4 sm:mx-0"
      aria-live="polite"
    >
      <AnimatePresence mode="popLayout" initial={false}>
      {toasts.map((t) => {
        const tone = TONES[t.tone];
        return (
          <motion.div
            key={t.id}
            layout={animated}
            initial={animated ? { opacity: 0, y: -12 } : false}
            animate={{ opacity: 1, y: 0, x: 0 }}
            exit={animated ? { opacity: 0, scale: 0.94, transition: { duration: 0.18 } } : undefined}
            transition={{ type: "spring", stiffness: 420, damping: 34 }}
            drag={animated ? "x" : false}
            dragConstraints={{ left: 0, right: 0 }}
            dragElastic={0.6}
            dragSnapToOrigin
            onDragEnd={(_, info) => {
              if (Math.abs(info.offset.x) > 80 || Math.abs(info.velocity.x) > 500) dismiss(t.id);
            }}
            className={`pointer-events-auto relative flex touch-pan-y items-start gap-3 overflow-hidden rounded-xl border bg-ink-850/95 p-3 sm:p-3.5 ${tone.cls}`}
            role={t.tone === "error" ? "alert" : "status"}
          >
            <span className={`rounded-lg p-1.5 ${tone.dot}`}>
              <Icon name={tone.icon} className="h-4 w-4" strokeWidth={2.2} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-white">{t.title}</p>
              {t.message && <p className="mt-0.5 break-words text-xs text-neutral-400">{t.message}</p>}
            </div>
            <button
              onClick={() => dismiss(t.id)}
              className="-mr-1 -mt-1 grid h-9 w-9 shrink-0 place-items-center rounded-lg text-neutral-500 transition-colors hover:text-white active:bg-white/10"
              aria-label="Dismiss"
            >
              <Icon name="close" className="h-4 w-4" />
            </button>
            {animated && (
              <motion.span
                className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-current opacity-40"
                initial={{ scaleX: 1 }}
                animate={{ scaleX: 0 }}
                transition={{ duration: toastMs(t.tone) / 1000, ease: "linear" }}
                aria-hidden="true"
              />
            )}
          </motion.div>
        );
      })}
      </AnimatePresence>
    </div>
  );
}
