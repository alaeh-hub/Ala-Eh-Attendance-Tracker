import { useEffect, useState } from "react";
import Icon from "../../components/Icon";
import { ConfirmDialog, EmptyState, Field, Modal, PageHeader, Spinner } from "../../components/ui";
import api, { errorMessage } from "../../services/api";
import { toast } from "../../stores/toastStore";
import type { Department, Shift } from "../../types";

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

function toMinutes(t: string) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

/** End at or before start means the shift ends the next day (e.g. 22:00–06:00). */
function isOvernight(start: string | null | undefined, end: string | null | undefined) {
  return !!start && !!end && toMinutes(end) <= toMinutes(start);
}

/**
 * Where a break lies relative to a shift — the same rule the server applies.
 * Both are measured as offsets from the shift start, so overnight shifts and
 * breaks crossing midnight (23:30–00:30 in a 22:00–06:00 shift) compare correctly.
 */
function breakFit(shiftStart: string, shiftEnd: string, breakStart: string, breakEnd: string): "inside" | "outside" | "straddles" {
  const day = 24 * 60;
  const s = toMinutes(shiftStart);
  const span = (((toMinutes(shiftEnd) - s) % day) + day) % day || day;
  const b0 = (((toMinutes(breakStart) - s) % day) + day) % day;
  const b1 = b0 + ((((toMinutes(breakEnd) - toMinutes(breakStart)) % day) + day) % day);
  if (b1 <= span) return "inside";
  if (b0 >= span && b1 <= day) return "outside";
  return "straddles";
}

/** A one-hour break in the middle of a shift ("HH:MM" pair). */
function middleBreak(start: string, end: string): [string, string] {
  const day = 24 * 60;
  const s = toMinutes(start);
  const span = (((toMinutes(end) - s) % day) + day) % day || day;
  const b0 = (s + Math.floor(span / 2 / 30) * 30 - 30 + day) % day;
  const fmt = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return [fmt(b0), fmt((b0 + 60) % day)];
}

function NextDay({ start, end }: { start: string | null | undefined; end: string | null | undefined }) {
  if (!isOvernight(start, end)) return null;
  return (
    <span className="ml-1 rounded bg-indigo-500/15 px-1 py-px text-[10px] font-semibold uppercase tracking-wide text-indigo-200" title="Ends the next day">
      +1 day
    </span>
  );
}

function formatRange(start: string | null, end: string | null) {
  if (!start || !end) return "—";
  return (
    <>
      {start} – {end}
      <NextDay start={start} end={end} />
    </>
  );
}

export default function Departments() {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Department | "new" | null>(null);
  const [confirm, setConfirm] = useState<Department | null>(null);
  const [busy, setBusy] = useState(false);

  function load() {
    setLoading(true);
    api
      .get<Department[]>("/departments")
      .then((r) => setDepartments(r.data))
      .catch(() => toast.error("Couldn't load departments"))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  async function remove(dept: Department) {
    if (busy) return;
    setBusy(true);
    try {
      await api.delete(`/departments/${dept.id}`);
      setDepartments((prev) => prev.filter((d) => d.id !== dept.id));
      toast.success("Department deleted", dept.name);
      setConfirm(null);
    } catch (err) {
      toast.error("Couldn't delete department", errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Departments"
        subtitle="Define working hours, shifts and job roles for each department."
        actions={
          <button className="btn-primary" onClick={() => setEditing("new")}>
            <Icon name="plus" className="h-4 w-4" /> Add department
          </button>
        }
      />

      <div className="card overflow-hidden animate-fade-up" style={{ animationDelay: "80ms" }}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[800px] table-fixed text-sm">
            <colgroup>
              <col className="w-[200px]" />
              <col className="w-[260px]" />
              <col className="w-[200px]" />
              <col className="w-[110px]" />
              <col className="w-[90px]" />
            </colgroup>
            <thead className="border-b border-white/[0.06] bg-white/[0.02]">
              <tr>
                <th className="table-head">Department</th>
                <th className="table-head">Schedule</th>
                <th className="table-head">Roles</th>
                <th className="table-head">Employees</th>
                <th className="table-head text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              {loading &&
                Array.from({ length: 3 }).map((_, i) => (
                  <tr key={i}>
                    <td className="table-cell" colSpan={5}>
                      <div className="skeleton h-9 w-full max-w-md" />
                    </td>
                  </tr>
                ))}
              {!loading &&
                departments.map((d) => (
                  <tr key={d.id} className="transition-colors hover:bg-white/[0.02]">
                    <td className="table-cell">
                      <p className="font-semibold text-white">{d.name}</p>
                    </td>
                    <td className="table-cell">
                      {d.has_shifting ? (
                        <div className="flex flex-wrap gap-1.5">
                          {d.shifts.map((s) => (
                            <span key={s.name} className="chip bg-sky-500/10 text-sky-300 ring-1 ring-sky-500/25">
                              {s.name}: {s.start_time}–{s.end_time}
                              <NextDay start={s.start_time} end={s.end_time} />
                            </span>
                          ))}
                        </div>
                      ) : (
                        <p className="text-neutral-300">
                          {formatRange(d.start_time, d.end_time)}
                          {d.break_start && d.break_end && <span className="text-neutral-500"> · break {d.break_start}–{d.break_end}</span>}
                        </p>
                      )}
                    </td>
                    <td className="table-cell">
                      {d.roles.length ? (
                        <div className="flex flex-wrap gap-1.5">
                          {d.roles.map((r) => (
                            <span key={r} className="chip bg-white/[0.06] text-neutral-300 ring-1 ring-white/10">
                              {r}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-neutral-500">—</span>
                      )}
                    </td>
                    <td className="table-cell text-neutral-300">{d.employee_count}</td>
                    <td className="table-cell">
                      <div className="flex justify-end gap-1">
                        <button onClick={() => setEditing(d)} className="rounded-lg p-2 text-neutral-400 transition-colors hover:bg-white/10 hover:text-white" title="Edit" aria-label={`Edit ${d.name}`}>
                          <Icon name="edit" className="h-4 w-4" />
                        </button>
                        <button onClick={() => setConfirm(d)} className="rounded-lg p-2 text-neutral-500 transition-colors hover:bg-red-500/10 hover:text-red-300" title="Delete" aria-label={`Delete ${d.name}`}>
                          <Icon name="trash" className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {!loading && departments.length === 0 && (
          <EmptyState
            icon="building"
            title="No departments yet"
            message="Add a department to set its working hours and job roles."
            action={
              <button className="btn-primary" onClick={() => setEditing("new")}>
                Add department
              </button>
            }
          />
        )}
      </div>

      {editing && (
        <DepartmentForm
          department={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(d) => {
            setDepartments((prev) => (prev.some((p) => p.id === d.id) ? prev.map((p) => (p.id === d.id ? d : p)) : [...prev, d].sort((a, b) => a.name.localeCompare(b.name))));
            setEditing(null);
          }}
        />
      )}

      <ConfirmDialog
        open={!!confirm}
        title="Delete department?"
        danger
        busy={busy}
        confirmLabel="Delete"
        message={
          <>
            This permanently deletes <b className="text-white">{confirm?.name}</b>. Employees must be reassigned to another department first.
          </>
        }
        onConfirm={() => confirm && remove(confirm)}
        onClose={() => !busy && setConfirm(null)}
      />
    </>
  );
}

function DepartmentForm({ department, onClose, onSaved }: { department: Department | null; onClose: () => void; onSaved: (d: Department) => void }) {
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

  /** Why the break doesn't fit the schedule (mirrors the server's check), or null. */
  function breakProblem(): string | null {
    const { break_start: bs, break_end: be } = form;
    if (!bs || !be) return "Enter a break start and end time.";
    if (bs === be) return "Break end must be after break start.";
    if (!form.has_shifting && form.start_time && form.end_time && form.start_time !== form.end_time) {
      if (breakFit(form.start_time, form.end_time, bs, be) !== "inside")
        return `The ${bs}–${be} break must fall inside the ${form.start_time}–${form.end_time} working hours.`;
    }
    if (form.has_shifting) {
      const bad = form.shifts.find((sh) => sh.start_time !== sh.end_time && breakFit(sh.start_time, sh.end_time, bs, be) === "straddles");
      if (bad) return `The ${bs}–${be} break overlaps the start or end of the "${bad.name}" shift (${bad.start_time}–${bad.end_time}).`;
    }
    return null;
  }
  const breakIssue = breakProblem();

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
      onClose={onClose}
      title={department ? "Edit department" : "Add department"}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose} disabled={saving}>
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
              <span className="block text-xs text-neutral-500">Turn on if staff rotate across different hours (e.g. morning / night shift).</span>
            </span>
          </label>

          {!form.has_shifting ? (
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field label="Start time">
                <input className="input" type="time" value={form.start_time} onChange={(e) => setHours({ start_time: e.target.value })} />
              </Field>
              <Field label="End time" hint={fixedOvernight ? "Ends the next day (overnight schedule)." : "An end at or before the start means an overnight schedule."}>
                <input className="input" type="time" value={form.end_time} onChange={(e) => setHours({ end_time: e.target.value })} />
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
                      <button type="button" onClick={() => removeShift(i)} className="rounded-lg p-1 text-neutral-500 hover:bg-red-500/10 hover:text-red-300" aria-label={`Remove shift ${s.name}`}>
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
                  <input className="input" type="time" value={shiftDraft.start_time} onChange={(e) => setShiftDraft((s) => ({ ...s, start_time: e.target.value }))} />
                </Field>
                <Field label="End">
                  <input className="input" type="time" value={shiftDraft.end_time} onChange={(e) => setShiftDraft((s) => ({ ...s, end_time: e.target.value }))} />
                </Field>
                <button type="button" className="btn-ghost h-[42px]" onClick={addShift}>
                  <Icon name="plus" className="h-4 w-4" /> Add
                </button>
              </div>
              <p className="mt-2 text-xs text-neutral-500">
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
          <p className="mb-4 text-xs text-neutral-500">
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
              <input className="input" type="time" value={form.break_start} onChange={(e) => setForm((f) => ({ ...f, break_start: e.target.value }))} />
            </Field>
            <Field label="Break end">
              <input className="input" type="time" value={form.break_end} onChange={(e) => setForm((f) => ({ ...f, break_end: e.target.value }))} />
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
                <span key={r} className="chip bg-white/[0.06] text-neutral-300 ring-1 ring-white/10">
                  {r}
                  <button type="button" onClick={() => removeRole(r)} className="ml-1 text-neutral-500 hover:text-red-300" aria-label={`Remove ${r}`}>
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
        <p role="alert" className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm text-red-300">
          {error}
        </p>
      )}
    </Modal>
  );
}
