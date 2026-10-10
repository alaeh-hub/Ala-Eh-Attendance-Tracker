import { ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import api from "../services/api";
import Icon, { IconName } from "./Icon";

/**
 * Animates a displayed integer toward `value` whenever it changes, so a
 * live stat (present count, on-site count) visibly ticks instead of
 * silently jumping — the motion signals "this just changed," not decoration.
 * Respects prefers-reduced-motion by snapping instantly.
 */
export function useCountUp(value: number, duration = 500) {
  const [display, setDisplay] = useState(value);
  const from = useRef(value);

  useEffect(() => {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce || value === from.current) {
      from.current = value;
      setDisplay(value);
      return;
    }
    const start = performance.now();
    const startValue = from.current;
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(startValue + (value - startValue) * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);

  return display;
}

export function Spinner({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
      <path className="opacity-90" d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function initials(name?: string | null) {
  if (!name) return "?";
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join("");
}

// Photos need the auth header, so they're fetched as blobs and cached per session.
const photoCache = new Map<string, Promise<string | null>>();

export function forgetPhoto(userId: string) {
  photoCache.delete(userId);
}

function loadPhoto(userId: string) {
  if (!photoCache.has(userId)) {
    photoCache.set(
      userId,
      api
        .get(`/users/${userId}/photo`, { responseType: "blob" })
        .then((res) => URL.createObjectURL(res.data))
        .catch(() => {
          // Don't cache failures, so a transient error doesn't hide the photo for the whole session.
          photoCache.delete(userId);
          return null;
        })
    );
  }
  return photoCache.get(userId)!;
}

export function Avatar({
  userId,
  name,
  hasPhoto,
  size = "h-9 w-9",
  text = "text-xs",
  ring = false,
  version = 0,
}: {
  userId?: string | null;
  name?: string | null;
  hasPhoto?: boolean;
  size?: string;
  text?: string;
  ring?: boolean;
  version?: number;
}) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setSrc(null);
    if (userId && hasPhoto) loadPhoto(userId).then((url) => alive && setSrc(url));
    return () => {
      alive = false;
    };
  }, [userId, hasPhoto, version]);

  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-gradient-to-br from-brand-400 to-brand-700 font-bold text-black ${size} ${text} ${
        ring ? "ring-2 ring-brand-500/60 ring-offset-2 ring-offset-ink-900" : ""
      }`}
    >
      {src ? <img src={src} alt="" className="h-full w-full object-cover animate-fade-in" /> : initials(name)}
    </span>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
  leading,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** Rendered to the left of the title — e.g. the mascot on the dashboard. */
  leading?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-col gap-4 animate-fade-up sm:flex-row sm:items-end sm:justify-between">
      <div className="flex items-center gap-3">
        {leading}
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight text-white sm:text-3xl">{title}</h1>
          {subtitle && <p className="mt-1 text-sm text-neutral-400">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  accent = false,
  loading = false,
  delay = 0,
}: {
  label: string;
  value: number;
  hint?: ReactNode;
  /** The headline stat gets a slightly stronger brand wash; every card shares the same yellow outline. */
  accent?: boolean;
  loading?: boolean;
  delay?: number;
}) {
  const shown = useCountUp(value);
  return (
    <div
      className={`card group relative border border-brand-500/30 p-5 animate-fade-up transition-all duration-300 hover:-translate-y-0.5 hover:border-brand-500/50 ${
        accent ? "bg-gradient-to-br from-brand-500/[0.14] to-ink-850/80" : ""
      }`}
      style={{ animationDelay: `${delay}ms` }}
    >
      <p className="text-xs font-semibold uppercase tracking-wider text-neutral-400">{label}</p>
      {loading ? (
        <div className="skeleton mt-3 h-9 w-16" />
      ) : (
        <p className="mt-2 text-4xl font-extrabold tabular-nums tracking-tight text-white">{shown}</p>
      )}
      {hint && <p className="mt-1 text-xs text-neutral-500">{hint}</p>}
    </div>
  );
}

export function EmptyState({ icon, title, message, action }: { icon: IconName; title: string; message?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center animate-fade-in">
      <span className="mb-4 rounded-2xl border border-brand-500/20 bg-brand-500/10 p-4 text-brand-400">
        <Icon name={icon} className="h-7 w-7" />
      </span>
      <p className="font-semibold text-neutral-200">{title}</p>
      {message && <p className="mt-1 max-w-sm text-sm text-neutral-500">{message}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-fade-in" onClick={onClose} />
      <div className={`card relative max-h-[92vh] w-full overflow-y-auto rounded-b-none border-white/10 bg-ink-850 animate-scale-in sm:rounded-2xl ${wide ? "sm:max-w-2xl" : "sm:max-w-md"}`}>
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-white/[0.06] bg-ink-850/95 px-6 py-4 backdrop-blur">
          <h2 className="text-lg font-bold text-white">{title}</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-neutral-400 hover:bg-white/10 hover:text-white" aria-label="Close">
            <Icon name="close" className="h-5 w-5" />
          </button>
        </div>
        <div className="px-6 py-5">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-white/[0.06] px-6 py-4">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  danger = false,
  busy = false,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className={danger ? "btn-danger" : "btn-primary"} onClick={onConfirm} disabled={busy}>
            {busy && <Spinner />}
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="text-sm leading-relaxed text-neutral-300">{message}</div>
    </Modal>
  );
}

const ROLE_STYLES: Record<string, string> = {
  ADMIN: "bg-brand-500/15 text-brand-300 ring-1 ring-brand-500/30",
  OPERATOR: "bg-sky-500/10 text-sky-300 ring-1 ring-sky-500/25",
  STAFF: "bg-white/[0.06] text-neutral-300 ring-1 ring-white/10",
};

export function RoleBadge({ role }: { role: string }) {
  return <span className={`chip ${ROLE_STYLES[role] || ROLE_STYLES.STAFF}`}>{role.charAt(0) + role.slice(1).toLowerCase()}</span>;
}

export function formatMinutes(mins: number) {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

export function EventBadge({
  type,
  session,
  late,
  lateMinutes,
  earlyMinutes,
}: {
  type: "CLOCK_IN" | "CLOCK_OUT";
  session?: "AM" | "PM" | "OT";
  late?: boolean;
  lateMinutes?: number | null;
  earlyMinutes?: number | null;
}) {
  const otPrefix = session === "OT" ? "OT " : "";
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
      <span
        className={`chip ${
          type === "CLOCK_IN"
            ? session === "OT"
              ? "bg-violet-500/10 text-violet-300 ring-1 ring-violet-500/25"
              : "bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/25"
            : "bg-white/[0.06] text-neutral-300 ring-1 ring-white/10"
        }`}
      >
        <Icon name={type === "CLOCK_IN" ? "login" : "logout"} className="h-3 w-3" strokeWidth={2.4} />
        {otPrefix}
        {type === "CLOCK_IN" ? "Clock in" : "Clock out"}
      </span>
      {late && (
        <span className="chip bg-orange-500/10 text-orange-300 ring-1 ring-orange-500/25">
          <Icon name="clock" className="h-3 w-3" strokeWidth={2.4} />
          {lateMinutes ? `Late ${formatMinutes(lateMinutes)}` : "Late"}
        </span>
      )}
      {!!earlyMinutes && (
        <span className="chip bg-sky-500/10 text-sky-300 ring-1 ring-sky-500/25">
          <Icon name="clock" className="h-3 w-3" strokeWidth={2.4} />
          Left {formatMinutes(earlyMinutes)} early
        </span>
      )}
      {!late && !earlyMinutes && session !== "OT" && (
        <span className="chip bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/25">
          <Icon name="check" className="h-3 w-3" strokeWidth={2.4} />
          Valid
        </span>
      )}
    </span>
  );
}

export function Field({ label, children, hint, error }: { label: string; children: ReactNode; hint?: string; error?: string }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {error ? <span className="mt-1 block text-xs text-red-400">{error}</span> : hint && <span className="mt-1 block text-xs text-neutral-500">{hint}</span>}
    </label>
  );
}

export function formatTime(iso: string | null | undefined) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function formatDateTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function timeAgo(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
