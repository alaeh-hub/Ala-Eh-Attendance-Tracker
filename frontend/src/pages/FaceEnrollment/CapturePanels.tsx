import Icon from "../../components/Icon";
import { Spinner } from "../../components/ui";
import type { User } from "../../types";
import { dockBtn, ghostBtn } from "./captureStyles";
import KioskPanel from "./KioskPanel";

/** Things that need an answer take over the screen, like the kiosk's result overlays. One at a time. */
export default function CapturePanels({ employee, blocking, needsConsent, outdated, allPosesDone, count, canFinish, finishing, resetting,
  onDismissBlocking, onConsent, onBack, onReset, onFinish, onConfirmReset }: {
  employee: User;
  blocking: string | null;
  needsConsent: boolean;
  outdated: number;
  allPosesDone: boolean;
  count: number;
  canFinish: boolean;
  finishing: boolean;
  resetting: boolean;
  onDismissBlocking: () => void;
  onConsent: () => void;
  onBack: () => void;
  onReset: () => void;
  onFinish: () => void;
  onConfirmReset: () => void;
}) {
  return (
    <>
  {blocking && (
    <KioskPanel tone="error">
      <span className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-red-500 text-white">
        <Icon name="shield" className="h-10 w-10" strokeWidth={2.2} />
      </span>
      <p role="alert" className="text-2xl font-extrabold text-white sm:text-3xl">Capture blocked for accuracy</p>
      <p className="mt-2 text-base text-red-200">{blocking}</p>
      <div className="mt-6 grid gap-2">
        <button className={`${dockBtn} bg-brand-500 text-black hover:bg-brand-400`} onClick={onDismissBlocking}>
          <Icon name="refresh" className="h-5 w-5" /> Dismiss &amp; retry
        </button>
        <button className={ghostBtn} onClick={onBack}>
          Choose a different employee
        </button>
      </div>
    </KioskPanel>
  )}

  {!blocking && needsConsent && (
    <KioskPanel tone="info">
      <span className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-brand-500 text-black">
        <Icon name="shield" className="h-10 w-10" strokeWidth={2.2} />
      </span>
      <p className="text-2xl font-extrabold text-white sm:text-3xl">Biometric consent</p>
      <p className="mt-2 text-base text-neutral-300">{employee.full_name} has agreed to their face being stored for attendance. Capture starts once you confirm.</p>
      <div className="mt-6 grid gap-2">
        <button className={`${dockBtn} bg-brand-500 text-black hover:bg-brand-400`} onClick={onConsent}>
          <Icon name="check" className="h-5 w-5" strokeWidth={3} /> They agree. Start
        </button>
        <button className={ghostBtn} onClick={onBack}>
          Back
        </button>
      </div>
    </KioskPanel>
  )}

  {!blocking && !needsConsent && outdated > 0 && (
    <KioskPanel tone="warn">
      <span className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-orange-500 text-black">
        <Icon name="alert" className="h-10 w-10" strokeWidth={2.2} />
      </span>
      <p className="text-2xl font-extrabold text-white sm:text-3xl">Re-enrollment needed</p>
      <p className="mt-2 text-base text-neutral-300">{outdated} samples were captured with the previous recognition engine and can't be used. Clear them, then capture again.</p>
      <div className="mt-6 grid gap-2">
        <button className={`${dockBtn} bg-brand-500 text-black hover:bg-brand-400`} onClick={onReset} disabled={resetting}>
          {resetting ? <Spinner /> : <Icon name="refresh" className="h-5 w-5" />} Clear old samples
        </button>
        <button className={ghostBtn} onClick={onBack}>
          Back
        </button>
      </div>
    </KioskPanel>
  )}

  {allPosesDone && !blocking && (
    <KioskPanel tone="success">
      <div className="relative mx-auto mb-4 h-24 w-24">
        <span className="absolute -inset-3 rounded-full bg-emerald-500/25 animate-pulse-ring" />
        <span className="relative flex h-24 w-24 items-center justify-center rounded-full bg-emerald-500 text-black">
          <svg viewBox="0 0 24 24" className="h-12 w-12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M20 6 9 17l-5-5" strokeDasharray="48" className="animate-draw-check" />
          </svg>
        </span>
      </div>
      <p className="text-sm font-semibold text-brand-400">All poses captured</p>
      <p className="mt-1 text-2xl font-extrabold text-white sm:text-3xl">{employee.full_name}</p>
      <p className="mt-1 text-sm text-neutral-400">{count} face samples saved. The camera is turned off.</p>
      <div className="mt-6 grid gap-2">
        <button className={`${dockBtn} bg-emerald-500 text-black hover:bg-emerald-400`} onClick={onFinish} disabled={!canFinish || finishing} aria-busy={finishing}>
          {finishing ? <Spinner /> : <Icon name="check" className="h-5 w-5" strokeWidth={3} />} Finish enrollment
        </button>
        <button className={ghostBtn} onClick={onConfirmReset} disabled={count === 0}>
          <Icon name="refresh" className="h-5 w-5" /> Start over
        </button>
      </div>
    </KioskPanel>
  )}
    </>
  );
}
