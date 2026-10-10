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

function formatRange(start: string | null, end: string | null) {
  if (!start || !end) return "—";
  return `${start} – ${end}`;
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
                        <button onClick={() => setEditing(d)} className="rounded-lg p-2 text-neutral-400 transition-colors hover:bg-white/10 hover:text-white" title="Edit">
                          <Icon name="edit" className="h-4 w-4" />
                        </button>
                        <button onClick={() => setConfirm(d)} className="rounded-lg p-2 text-neutral-500 transition-colors hover:bg-red-500/10 hover:text-red-300" title="Delete">
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
        onClose={() => setConfirm(null)}
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

  function addShift() {
    if (!shiftDraft.name.trim()) return;
    setForm((f) => ({ ...f, shifts: [...f.shifts, { ...shiftDraft, name: shiftDraft.name.trim() }] }));
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

  async function save() {
    setError(null);
    if (!form.name.trim()) {
      setError("A department name is required.");
      return;
    }
    if (form.has_shifting && form.shifts.length === 0) {
      setError("Add at least one shift, or turn off shifting.");
      return;
    }
    if (form.break_end <= form.break_start) {
      setError("Break end must be after break start.");
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
              <Field label="AM start time">
                <input className="input" type="time" value={form.start_time} onChange={(e) => setForm((f) => ({ ...f, start_time: e.target.value }))} />
              </Field>
              <Field label="PM end time">
                <input className="input" type="time" value={form.end_time} onChange={(e) => setForm((f) => ({ ...f, end_time: e.target.value }))} />
              </Field>
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
                      </span>
                      <button type="button" onClick={() => removeShift(i)} className="rounded-lg p-1 text-neutral-500 hover:bg-red-500/10 hover:text-red-300" aria-label="Remove shift">
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
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
          <p className="text-sm font-semibold text-white">Lunch break</p>
          <p className="mb-4 text-xs text-neutral-500">
            Not counted as worked time. An employee can time out for lunch and back in, or stay scanned straight through — either way this window is excluded automatically.
            {!form.has_shifting && <> E.g. AM in {form.start_time || "08:00"} → break {form.break_start}–{form.break_end} → PM out {form.end_time || "17:00"}.</>}
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Break start">
              <input className="input" type="time" value={form.break_start} onChange={(e) => setForm((f) => ({ ...f, break_start: e.target.value }))} />
            </Field>
            <Field label="Break end">
              <input className="input" type="time" value={form.break_end} onChange={(e) => setForm((f) => ({ ...f, break_end: e.target.value }))} />
            </Field>
          </div>
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
