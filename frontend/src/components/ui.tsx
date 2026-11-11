import { ButtonHTMLAttributes, ReactNode, forwardRef, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { animate as tween } from "motion";
import { AnimatePresence, motion, useDragControls } from "motion/react";
import { EASE_OUT, motionOK } from "../lib/motion";
import { loadPhoto } from "../utils/photoCache";
import Icon, { IconName } from "./Icon";

/**
 * Animates a displayed integer toward `value` (motion.dev), so a live stat visibly ticks instead of silently jumping.
 * Snaps instantly under reduced motion.
 */
export function useCountUp(value: number, duration = 0.9) {
  // Shows the first value immediately (the page already has its own entrance), then glides between values as they change.
  const [display, setDisplay] = useState(value);
  const shown = useRef(display);

  useEffect(() => {
    if (!motionOK() || value === shown.current) {
      shown.current = value;
      setDisplay(value);
      return;
    }
    const controls = tween(shown.current, value, {
      duration,
      ease: EASE_OUT,
      onUpdate: (v) => {
        shown.current = v;
        setDisplay(Math.round(v));
      },
    });
    return () => controls.stop();
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

export { clearPhotoCache, forgetPhoto, photoCacheSize } from "../utils/photoCache";

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
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-brand-500 font-bold text-black ${size} ${text} ${
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
    <div className="mb-5 sm:mb-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
        <div className="flex min-w-0 items-center gap-3">
          {leading}
          <div className="min-w-0">
            <h1 className="font-display text-3xl font-bold tracking-tight text-white sm:text-4xl">
              {title}
            </h1>
            {subtitle && <p className="mt-1 text-sm text-neutral-400">{subtitle}</p>}
          </div>
        </div>
        {actions && <div className="page-actions flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
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
      className={`stat ${accent ? "stat-accent" : ""}`}
    >
      <p className="text-sm font-medium text-neutral-400">{label}</p>
      {loading ? (
        <div className="skeleton mt-3 h-8 w-14 sm:h-9 sm:w-16" />
      ) : (
        <p className={`mt-2 font-display text-6xl font-bold tabular-nums tracking-tight ${accent ? "text-brand-400" : "text-white"}`}>{shown}</p>
      )}
      {hint && <p className="mt-1 text-xs text-neutral-400">{hint}</p>}
    </div>
  );
}

/** Icon-only button: a 40px hit area, an accessible name from `label`, and a tooltip. */
export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; tone?: "default" | "danger" | "brand" }>(function IconButton(
  { label, tone = "default", className = "", children, type = "button", ...rest },
  ref
) {
  const hover = tone === "danger" ? "hover:bg-red-500/10 hover:text-red-300" : tone === "brand" ? "hover:bg-brand-500/10 hover:text-brand-300" : "hover:bg-white/10 hover:text-white";
  return (
    <button ref={ref} type={type} title={label} aria-label={label} className={`inline-grid h-10 w-10 place-items-center rounded-lg text-neutral-300 transition-colors disabled:opacity-50 ${hover} ${className}`} {...rest}>
      {children}
    </button>
  );
});

/** A row of mutually exclusive choices (a filter, a date preset). `value` may be null when none of them is active. */
export function Segmented<K extends string>({
  options,
  value,
  onChange,
  label,
  className = "",
}: {
  options: { key: K; label: ReactNode }[];
  value: K | null;
  onChange: (key: K) => void;
  label: string;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={`flex flex-wrap items-center gap-2 ${className}`}>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          aria-pressed={value === o.key}
          onClick={() => onChange(o.key)}
          className={`rounded-lg px-3 py-2 text-xs font-semibold transition-colors sm:py-1.5 ${value === o.key ? "bg-brand-500 text-black" : "bg-white/[0.04] text-neutral-300 hover:bg-white/[0.08]"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** An inline notice: a hairline-ruled strip with an icon. `tone` picks the colour; errors announce themselves (role="alert"). */
export function Banner({ tone = "error", children, className = "" }: { tone?: "error" | "warn" | "info"; children: ReactNode; className?: string }) {
  const cls = tone === "error" ? "border-red-500/60 text-red-300" : tone === "warn" ? "border-orange-400/60 text-orange-200" : "border-brand-500/50 text-brand-200";
  return (
    <div role={tone === "info" ? "status" : "alert"} className={`flex items-start gap-2 border-l-2 bg-white/[0.03] py-2.5 pl-3 pr-4 text-sm ${cls} ${className}`}>
      <Icon name={tone === "info" ? "info" : "alert"} className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function EmptyState({ icon, title, message, action }: { icon: IconName; title: string; message?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-10 text-center animate-fade-in sm:py-14">
      <motion.span
        className="mb-4 text-brand-400"
        initial={motionOK() ? { opacity: 0, scale: 0.6, rotate: -10 } : false}
        animate={{ opacity: 1, scale: 1, rotate: 0 }}
        transition={{ type: "spring", stiffness: 300, damping: 16, delay: 0.1 }}
      >
        <Icon name={icon} className="h-8 w-8" />
      </motion.span>
      <p className="font-semibold text-neutral-200">{title}</p>
      {message && <p className="mt-1 max-w-sm text-sm text-neutral-400">{message}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const dragControls = useDragControls();
  // Phones get a bottom sheet: drag its header down to dismiss. Decided once per open so it doesn't flip mid-gesture.
  const sheet = useRef<boolean | null>(null);
  if (sheet.current === null || !open) sheet.current = motionOK() && !!window.matchMedia?.("(max-width: 639.98px)").matches;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Focus moves into the dialog on open, Tab cycles inside it, Escape closes
  // it, and focus returns to whatever opened it on close.
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    // The page behind a dialog must not scroll under the user's finger.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusables = () => (panel ? Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)) : []);
    // Respect an autoFocus inside the dialog; otherwise focus the first control.
    if (panel && !panel.contains(document.activeElement)) (focusables()[0] ?? panel).focus();

    const onKey = (e: KeyboardEvent) => {
      // With a dialog stacked on top of this one, only the topmost reacts.
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (panel && dialogs.length > 1 && dialogs[dialogs.length - 1] !== panel) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (e.shiftKey && (active === first || !panel.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      if (previous && document.contains(previous)) previous.focus();
    };
  }, [open]);

  // Exits only play when the parent keeps <Modal> mounted and flips `open` (ConfirmDialog does); a parent that
  // unmounts it outright still closes instantly. Tests and reduced-motion users get no animation at all.
  const animated = motionOK();
  return createPortal(
    <AnimatePresence>
      {open && (
    <div key="modal" className="fixed inset-0 z-[var(--z-modal)] flex items-end justify-center p-0 sm:items-center sm:p-4">
      <motion.div
        className="absolute inset-0 bg-black/70"
        initial={animated ? { opacity: 0 } : false}
        animate={{ opacity: 1 }}
        exit={animated ? { opacity: 0, transition: { duration: 0.18 } } : undefined}
        transition={{ duration: 0.22 }}
        onClick={onClose}
        aria-hidden="true"
      />
      <motion.div
        ref={panelRef}
        initial={animated ? (sheet.current ? { opacity: 1, y: "100%" } : { opacity: 0, y: 18, scale: 0.97 }) : false}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={animated ? (sheet.current ? { y: "100%", transition: { duration: 0.24, ease: [0.55, 0, 1, 0.45] } } : { opacity: 0, y: 10, scale: 0.98, transition: { duration: 0.16 } }) : undefined}
        transition={{ type: "spring", stiffness: 380, damping: 32 }}
        drag={sheet.current ? "y" : false}
        dragControls={dragControls}
        dragListener={false}
        dragConstraints={{ top: 0, bottom: 0 }}
        dragElastic={{ top: 0, bottom: 0.6 }}
        onDragEnd={(_, info) => {
          if (info.offset.y > 110 || info.velocity.y > 600) onCloseRef.current();
        }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`surface relative max-h-[92dvh] w-full overflow-y-auto overscroll-contain rounded-b-none border-white/10 bg-ink-850 outline-none sm:rounded-2xl ${wide ? "sm:max-w-2xl" : "sm:max-w-md"}`}
      >
        <div
          className="sticky top-0 z-10 border-b border-white/[0.06] bg-ink-850/95 px-4 pb-3 pt-2 sm:px-6 sm:py-4"
          style={sheet.current ? { touchAction: "none" } : undefined}
          onPointerDown={(e) => sheet.current && dragControls.start(e)}
        >
          <span className="mx-auto mb-2 block h-1 w-9 rounded-full bg-white/20 sm:hidden" aria-hidden="true" />
          <div className="flex items-center justify-between gap-3">
            <h2 id={titleId} className="min-w-0 text-base font-bold text-white sm:text-lg">{title}</h2>
            <button onClick={onClose} onPointerDown={(e) => e.stopPropagation()} className="-mr-2 grid h-10 w-10 place-items-center rounded-lg text-neutral-400 hover:bg-white/10 hover:text-white active:bg-white/10 sm:mr-0 sm:h-9 sm:w-9" aria-label="Close">
              <Icon name="close" className="h-5 w-5" />
            </button>
          </div>
        </div>
        <div className="px-4 py-4 sm:px-6 sm:py-5">{children}</div>
        {footer && (
          <div className="flex flex-col-reverse gap-2 border-t border-white/[0.06] px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-3 sm:flex-row sm:flex-wrap sm:justify-end sm:px-6 sm:py-4 [&>button]:w-full sm:[&>button]:w-auto">{footer}</div>
        )}
      </motion.div>
    </div>
      )}
    </AnimatePresence>,
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

const ROLE_TAG: Record<string, string> = { ADMIN: "tag-accent", OPERATOR: "tag-info", STAFF: "tag-muted", KIOSK: "tag-info" };

export function RoleBadge({ role }: { role: string }) {
  return <span className={`tag ${ROLE_TAG[role] || "tag-muted"}`}>{role.charAt(0) + role.slice(1).toLowerCase()}</span>;
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
  const overtime = session === "OT";
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-x-3 gap-y-0.5">
      <span className={`tag ${type === "CLOCK_IN" ? "tag-in" : "tag-out"}`}>
        <Icon name={type === "CLOCK_IN" ? "login" : "logout"} className="h-3.5 w-3.5" strokeWidth={2.2} />
        {overtime ? "OT " : ""}
        {type === "CLOCK_IN" ? "Clock in" : "Clock out"}
      </span>
      {late && (
        <span className="tag tag-warn">
          <Icon name="clock" className="h-3.5 w-3.5" strokeWidth={2.2} />
          {lateMinutes ? `Late ${formatMinutes(lateMinutes)}` : "Late"}
        </span>
      )}
      {!!earlyMinutes && (
        <span className="tag tag-info">
          <Icon name="clock" className="h-3.5 w-3.5" strokeWidth={2.2} />
          Left {formatMinutes(earlyMinutes)} early
        </span>
      )}
      {!late && !earlyMinutes && !overtime && (
        <span className="tag tag-muted">
          <Icon name="check" className="h-3.5 w-3.5" strokeWidth={2.2} />
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
      {error ? <span className="mt-1 block text-xs text-red-400">{error}</span> : hint && <span className="mt-1 block text-xs text-neutral-400">{hint}</span>}
    </label>
  );
}

// Times are shown in the organisation's timezone, not the browser's (see utils/orgTime).
export { formatDateTime, formatTime } from "../utils/orgTime";

export function timeAgo(iso: string) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
