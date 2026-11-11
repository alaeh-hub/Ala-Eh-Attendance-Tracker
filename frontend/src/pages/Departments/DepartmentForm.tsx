import { useRef, useState } from "react";
import { useDiscardGuard } from "../../components/useDiscardGuard";
import { TimeField } from "../../components/fields";
import Icon from "../../components/Icon";
import { Banner, Field, Modal, Spinner } from "../../components/ui";
import api, { errorMessage } from "../../services/api";
import { toast } from "../../stores/toastStore";
import type { Department, Shift } from "../../types";
import NextDay from "./NextDay";
import { breakFit, breakProblem, isOvernight, middleBreak } from "./scheduleRules";

const EMPTY_FORM = {
  name: "",
  has_shifting: false,
  start_time: "08:00",
  end_time: "17:00",
  break_start: "12:00",
  break_end: "13:00",
  shifts: [] as Shift[],
  roles: [] as string[],
};

export default function DepartmentForm({ department, onClose, onSaved }: { department: Department | null; onClose: () => void; onSaved: (d: Department) => void }) {
  const [form, setForm] = useState(() =>
    department
      ? {
          name: department.name,
          has_shifting: department.has_shifting,
          start_time: department.start_time ?? "08:00",
          end_time: department.end_time ?? "17:00",
          break_start: department.break_start ?? "12:00",
          break_end: department.break_end ?? "13:00",
          shifts: department.shifts.length ? department.shifts : [],
          roles: department.roles,
        }
      : EMPTY_FORM
  );
  const initialForm = useRef(JSON.stringify(form));
  const [shiftDraft, setShiftDraft] = useState({ name: "", start_time: "08:00", end_time: "17:00" });
  const [roleDraft, setRoleDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [shiftError, setShiftError] = useState<string | null>(null);

  function addShift() {
    const name = shiftDraft.name.trim();
    if (!name) {
      setShiftError("Give the shift a name.");
      return;
    }
    if (!shiftDraft.start_time || !shiftDraft.end_time) {
      setShiftError("Enter a start and an end time.");
      return;
    }
    if (shiftDraft.start_time === shiftDraft.end_time) {
      setShiftError("A shift can't start and end at the same time.");
      return;
    }
    if (form.shifts.some((s) => s.name.toLowerCase() === name.toLowerCase())) {
      setShiftError(`There is already a shift named "${name}".`);
      return;
    }
    setShiftError(null);
    setForm((f) => ({ ...f, shifts: [...f.shifts, { ...shiftDraft, name }] }));
    setShiftDraft({ name: "", start_time: "08:00", end_time: "17:00" });
  }

  function removeShift(i: number) {
    setForm((f) => ({ ...f, shifts: f.shifts.filter((_, idx) => idx !== i) }));
  }

  function addRole() {
    const name = roleDraft.trim();
    if (!name || form.roles.some((r) => r.toLowerCase() === name.toLowerCase())) return;
    setForm((f) => ({ ...f, roles: [...f.roles, name] }));
    setRoleDraft("");
  }

  function removeRole(name: string) {
    setForm((f) => ({ ...f, roles: f.roles.filter((r) => r !== name) }));
  }

  const fixedOvernight = !form.has_shifting && isOvernight(form.start_time, form.end_time);

  const breakIssue = breakProblem(form);

  /**
   * Change the fixed working hours. If the break no longer fits (typically the default 12:00–13:00
   * left on a 22:00–06:00 night schedule), move it to the middle of the new hours.
   */
  function setHours(patch: { start_time?: string; end_time?: string }) {
    setForm((f) => {
      const next = { ...f, ...patch };
      if (next.start_time && next.end_time && next.start_time !== next.end_time && next.break_start && next.break_end && next.break_start !== next.break_end) {
        if (breakFit(next.start_time, next.end_time, next.break_start, next.break_end) !== "inside") {
          const [bs, be] = middleBreak(next.start_time, next.end_time);
          next.break_start = bs;
          next.break_end = be;
        }
      }
      return next;
    });
  }

  const dirty = JSON.stringify(form) !== initialForm.current || roleDraft.trim() !== "" || shiftDraft.name.trim() !== "";
  const { requestClose, dialog: discardDialog } = useDiscardGuard(dirty, onClose, saving);

  async function save() {
    if (saving) return;
    setError(null);
    if (!form.name.trim()) {
      setError("A department name is required.");
      return;
    }
    if (form.has_shifting && form.shifts.length === 0) {
      setError("Add at least one shift, or turn off shifting.");
      return;
    }
    if (!form.has_shifting) {
      if (!form.start_time || !form.end_time) {
        setError("Enter a start and an end time.");
        return;
      }
      if (form.start_time === form.end_time) {
        setError("The workday can't start and end at the same time.");
        return;
      }
    }
    if (breakIssue) {
      setError(breakIssue);
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        has_shifting: form.has_shifting,
        start_time: form.has_shifting ? null : form.start_time,
        end_time: form.has_shifting ? null : form.end_time,
        break_start: form.break_start,
        break_end: form.break_end,
        shifts: form.has_shifting ? form.shifts : [],
        roles: form.roles,
      };
      const res = department ? await api.patch<Department>(`/departments/${department.id}`, payload) : await api.post<Department>("/departments", payload);
      toast.success("Department saved", res.data.name);
      onSaved(res.data);
    } catch (err) {
      setError(errorMessage(err, "Couldn't save the department."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      wide
      onClose={requestClose}
      title={department ? "Edit department" : "Add department"}
      footer={
        <>
          <button className="btn-ghost" onClick={requestClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn-primary" onClick={save} disabled={saving}>
            {saving && <Spinner />} Save department
          </button>
        </>
      }
    >
      <div className="grid gap-5">
        <Field label="Department name *">
          <input className="input" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Production" autoFocus />
        </Field>

        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              className="mt-0.5 h-5 w-5 cursor-pointer rounded accent-brand-500"
              checked={form.has_shifting}
              onChange={(e) => setForm((f) => ({ ...f, has_shifting: e.target.checked }))}
            />
            <span>
              <span className="text-sm font-semibold text-white">This department works in shifts</span>
              <span className="block text-xs text-neutral-400">Turn on if staff rotate across different hours (e.g. morning / night shift).</span>
            </span>
          </label>

          {!form.has_shifting ? (
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field label="Start time">
                <TimeField className="input" value={form.start_time} onChange={(e) => setHours({ start_time: e.target.value })} />
              </Field>
              <Field label="End time" hint={fixedOvernight ? "Ends the next day (overnight schedule)." : "An end at or before the start means an overnight schedule."}>
                <TimeField className="input" value={form.end_time} onChange={(e) => setHours({ end_time: e.target.value })} />
              </Field>
              {fixedOvernight && (
                <p className="rounded-xl bg-indigo-500/10 px-3 py-2 text-xs text-indigo-200 sm:col-span-2" role="status">
                  Overnight: {form.start_time} until {form.end_time} the next morning. Punches after midnight count toward the day the shift started.
                </p>
              )}
            </div>
          ) : (
            <div className="mt-4 animate-fade-in">
              {form.shifts.length > 0 && (
                <ul className="mb-3 space-y-2">
                  {form.shifts.map((s, i) => (
                    <li key={i} className="flex items-center justify-between gap-3 rounded-xl bg-white/[0.04] px-3 py-2 text-sm">
                      <span className="font-semibold text-white">{s.name}</span>
                      <span className="text-neutral-400">
                        {s.start_time} – {s.end_time}
                        <NextDay start={s.start_time} end={s.end_time} />
                      </span>
                      <button type="button" onClick={() => removeShift(i)} className="rounded-lg p-1 text-neutral-400 hover:bg-red-500/10 hover:text-red-300" aria-label={`Remove shift ${s.name}`}>
                        <Icon name="close" className="h-4 w-4" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end">
                <Field label="Shift name">
                  <input className="input" value={shiftDraft.name} onChange={(e) => setShiftDraft((s) => ({ ...s, name: e.target.value }))} placeholder="Morning shift" />
                </Field>
                <Field label="Start">
                  <TimeField className="input" value={shiftDraft.start_time} onChange={(e) => setShiftDraft((s) => ({ ...s, start_time: e.target.value }))} />
                </Field>
                <Field label="End">
                  <TimeField className="input" value={shiftDraft.end_time} onChange={(e) => setShiftDraft((s) => ({ ...s, end_time: e.target.value }))} />
                </Field>
                <button type="button" className="btn-ghost h-[42px]" onClick={addShift}>
                  <Icon name="plus" className="h-4 w-4" /> Add
                </button>
              </div>
              <p className="mt-2 text-xs text-neutral-400">
                {isOvernight(shiftDraft.start_time, shiftDraft.end_time) ? (
                  <span className="text-indigo-200">This shift ends the next day (overnight).</span>
                ) : (
                  "An end at or before the start means the shift ends the next day (e.g. 22:00–06:00)."
                )}
              </p>
              {shiftError && (
                <p role="alert" className="mt-2 text-xs text-red-300">
                  {shiftError}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
          <p className="text-sm font-semibold text-white">Lunch break</p>
          <p className="mb-4 text-xs text-neutral-400">
            Not counted as worked time. An employee can time out for lunch and back in, or stay scanned straight through — either way this window is excluded automatically.
            {!form.has_shifting && (
              <>
                {" "}
                E.g. in {form.start_time || "08:00"} → break {form.break_start}–{form.break_end} → out {form.end_time || "17:00"}
                {fixedOvernight && " (next day)"}.
              </>
            )}{" "}
            {form.has_shifting
              ? "Shifts share this break: a shift may lie entirely outside it, but the break must not overlap a shift's start or end."
              : "The break must fall inside the working hours — for a night shift, put it inside the shift (it may cross midnight, e.g. 01:00–02:00 or 23:30–00:30)."}
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Break start">
              <TimeField className="input" value={form.break_start} onChange={(e) => setForm((f) => ({ ...f, break_start: e.target.value }))} />
            </Field>
            <Field label="Break end">
              <TimeField className="input" value={form.break_end} onChange={(e) => setForm((f) => ({ ...f, break_end: e.target.value }))} />
            </Field>
          </div>
          {breakIssue && (
            <p className="mt-3 text-xs text-orange-300" role="status">
              {breakIssue}
            </p>
          )}
        </div>

        <Field label="Job roles in this department" hint="These become dropdown options when enrolling an employee in this department.">
          {form.roles.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {form.roles.map((r) => (
                <span key={r} className="token">
                  {r}
                  <button type="button" onClick={() => removeRole(r)} className="ml-1 text-neutral-400 hover:text-red-300" aria-label={`Remove ${r}`}>
                    <Icon name="close" className="h-3 w-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <input
              className="input"
              aria-label="New job role"
              value={roleDraft}
              onChange={(e) => setRoleDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addRole();
                }
              }}
              placeholder="Line Operator"
            />
            <button type="button" className="btn-ghost" onClick={addRole}>
              <Icon name="plus" className="h-4 w-4" /> Add
            </button>
          </div>
        </Field>
      </div>

      {error && (
        <Banner tone="error" className="mt-4">{error}</Banner>
      )}
      {discardDialog}
    </Modal>
  );
}
