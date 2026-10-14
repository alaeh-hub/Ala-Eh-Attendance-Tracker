import { FormEvent, useEffect, useState } from "react";
import api, { errorMessage } from "../services/api";
import Icon from "./Icon";
import { Modal, Spinner } from "./ui";

export interface ClearAllResult {
  users_removed: number;
  face_samples: number;
  review_snapshots: number;
  attendance_events: number;
  /** No longer returned: the audit log is never cleared. */
  audit_entries?: number;
  /** `kiosks`: kiosk device accounts kept alongside operators. */
  kept: { admins: number; operators: number; kiosks?: number; departments: number };
}

const DELETED = [
  "All employees (staff accounts)",
  "All face samples and profile photos",
  "All attendance records and timesheets",
  "The whole review queue and its scan photos",
];

/**
 * The "factory reset" confirmation. It cannot be undone, so it spells out what goes and what
 * stays, and only enables the button once the admin has typed DELETE and their password.
 */
export default function ClearAllDataDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (r: ClearAllResult) => void }) {
  const [password, setPassword] = useState("");
  const [typed, setTyped] = useState("");
  const [removeOperators, setRemoveOperators] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPassword("");
      setTyped("");
      setRemoveOperators(false);
      setError(null);
    }
  }, [open]);

  const ready = password.length > 0 && typed === "DELETE" && !busy;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<ClearAllResult>("/admin/clear-all-data", { confirm: typed, password, keep_operators: !removeOperators });
      onDone(res.data);
    } catch (err) {
      setError(errorMessage(err, "Couldn't clear the data."));
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={busy ? () => undefined : onClose} title="Clear all data">
      <form onSubmit={submit} className="space-y-5 p-6 text-sm">
        <p className="flex items-start gap-2 rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-red-200">
          <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            This permanently deletes company data and <b>cannot be undone</b>.
          </span>
        </p>

        <div>
          <p className="mb-1.5 font-semibold text-white">Deleted</p>
          <ul className="space-y-1 text-neutral-300">
            {DELETED.map((d) => (
              <li key={d} className="flex gap-2">
                <Icon name="trash" className="mt-0.5 h-4 w-4 shrink-0 text-red-300" /> {d}
              </li>
            ))}
          </ul>
        </div>

        <div>
          <p className="mb-1.5 font-semibold text-white">Kept</p>
          <ul className="space-y-1 text-neutral-300">
            <li className="flex gap-2">
              <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" /> Administrator accounts
            </li>
            <li className="flex gap-2">
              <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" /> Departments and their settings
            </li>
            <li className="flex gap-2">
              <Icon name="check" className="mt-0.5 h-4 w-4 shrink-0 text-emerald-300" /> The audit log (the reset itself is recorded in it)
            </li>
            <li className="flex gap-2">
              <Icon name="check" className={`mt-0.5 h-4 w-4 shrink-0 ${removeOperators ? "text-neutral-600" : "text-emerald-300"}`} />
              <span className={removeOperators ? "line-through opacity-60" : ""}>Operator and kiosk device accounts</span>
            </li>
          </ul>
          <label className="mt-3 flex cursor-pointer items-center gap-3 text-neutral-300">
            <input type="checkbox" className="h-5 w-5 cursor-pointer rounded accent-brand-500" checked={removeOperators} onChange={(e) => setRemoveOperators(e.target.checked)} />
            Also delete operator and kiosk device accounts
          </label>
        </div>

        <div className="space-y-3">
          <label className="block">
            <span className="label">Your password</span>
            <input type="password" className="input" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <label className="block">
            <span className="label">
              Type <span className="font-mono text-red-300">DELETE</span> to confirm
            </span>
            <input className="input font-mono" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="DELETE" />
          </label>
        </div>

        {error && (
          <p role="alert" className="text-red-300">
            {error}
          </p>
        )}

        <div className="flex gap-2">
          <button type="button" className="btn-ghost flex-1" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn-danger flex-1" disabled={!ready}>
            {busy && <Spinner />}
            Delete everything
          </button>
        </div>
      </form>
    </Modal>
  );
}
