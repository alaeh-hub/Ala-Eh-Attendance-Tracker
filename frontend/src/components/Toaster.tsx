import { useToastStore } from "../stores/toastStore";
import Icon from "./Icon";

const TONES = {
  success: { icon: "check" as const, cls: "border-emerald-500/30 text-emerald-300", dot: "bg-emerald-500/15" },
  error: { icon: "x_circle" as const, cls: "border-red-500/30 text-red-300", dot: "bg-red-500/15" },
  info: { icon: "info" as const, cls: "border-brand-500/30 text-brand-300", dot: "bg-brand-500/15" },
};

export default function Toaster() {
  const { toasts, dismiss } = useToastStore();
  return (
    <div className="pointer-events-none fixed right-4 top-4 z-[60] flex w-[min(92vw,380px)] flex-col gap-2" aria-live="polite">
      {toasts.map((t) => {
        const tone = TONES[t.tone];
        return (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-start gap-3 rounded-xl border bg-ink-850/95 p-3.5 shadow-2xl backdrop-blur animate-slide-in ${tone.cls}`}
            role={t.tone === "error" ? "alert" : "status"}
          >
            <span className={`rounded-lg p-1.5 ${tone.dot}`}>
              <Icon name={tone.icon} className="h-4 w-4" strokeWidth={2.2} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-white">{t.title}</p>
              {t.message && <p className="mt-0.5 text-xs text-neutral-400">{t.message}</p>}
            </div>
            <button onClick={() => dismiss(t.id)} className="text-neutral-500 hover:text-white" aria-label="Dismiss">
              <Icon name="close" className="h-4 w-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
