import { useEffect, useState } from "react";
import Icon from "../../components/Icon";
import { ConfirmDialog, EmptyState, PageHeader } from "../../components/ui";
import api, { errorMessage } from "../../services/api";
import { toast } from "../../stores/toastStore";
import type { Department } from "../../types";
import DepartmentForm from "./DepartmentForm";
import NextDay from "./NextDay";

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

      <div className="panel overflow-hidden animate-fade-up" style={{ animationDelay: "80ms" }}>
        <div className="overflow-x-auto">
          <table className="rtable w-full min-w-[800px] table-fixed text-sm">
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
                    <td className="table-cell cell-primary">
                      <p className="font-semibold text-white">{d.name}</p>
                    </td>
                    <td data-label="Schedule" className="table-cell cell-full">
                      {d.has_shifting ? (
                        <div className="flex flex-col gap-1">
                          {d.shifts.map((s) => (
                            <span key={s.name} className="tag tag-info">
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
                    <td data-label="Roles" className="table-cell cell-full">
                      {d.roles.length ? (
                        <div className="flex flex-wrap gap-x-4 gap-y-1">
                          {d.roles.map((r) => (
                            <span key={r} className="text-sm text-neutral-300">
                              {r}
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-neutral-500">—</span>
                      )}
                    </td>
                    <td data-label="Employees" className="table-cell text-neutral-300">{d.employee_count}</td>
                    <td className="table-cell cell-actions">
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
