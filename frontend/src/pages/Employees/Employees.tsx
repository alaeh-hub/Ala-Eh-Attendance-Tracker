import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import Pager from "../../components/admin/Pager";
import { AnyRole, ROLE_HELP } from "../../components/admin/roles";
import ClearAllDataDialog, { ClearAllResult } from "../../components/ClearAllDataDialog";
import Icon from "../../components/Icon";
import { Avatar, ConfirmDialog, EmptyState, Field, Modal, PageHeader, RoleBadge, Spinner, forgetPhoto } from "../../components/ui";
import api, { errorMessage } from "../../services/api";
import { useAuthStore } from "../../stores/authStore";
import { toast } from "../../stores/toastStore";
import type { Department, User } from "../../types";
import { smartMatch } from "../../utils/search";

type StatusFilter = "all" | "active" | "inactive" | "not_enrolled";
type DeleteResult = { deleted?: boolean; archived?: boolean; id?: string };

const PAGE_SIZE = 50;

export default function Employees() {
  const me = useAuthStore((s) => s.user);
  const [users, setUsers] = useState<User[]>([]);
  const [deptList, setDeptList] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [department, setDepartment] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [editing, setEditing] = useState<User | null>(null);
  const [confirm, setConfirm] = useState<{ user: User; action: "deactivate" | "delete" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [page, setPage] = useState({ key: "", offset: 0 });

  useEffect(() => {
    api
      .get<User[]>("/users")
      .then((r) => setUsers(r.data))
      .catch(() => toast.error("Couldn't load employees"))
      .finally(() => setLoading(false));
    api.get<Department[]>("/departments").then((r) => setDeptList(r.data)).catch(() => undefined);
  }, []);

  const departments = useMemo(() => [...new Set(users.map((u) => u.department).filter(Boolean) as string[])].sort(), [users]);

  const filtered = useMemo(() => {
    return users.filter((u) => {
      if (department && u.department !== department) return false;
      if (status === "active" && !u.is_active) return false;
      if (status === "inactive" && u.is_active) return false;
      if (status === "not_enrolled" && (u.enrolled || u.role === "KIOSK")) return false;
      return smartMatch(search, [u.full_name, u.email, u.employee_code, u.department, u.position]);
    });
  }, [users, search, department, status]);

  // Paging restarts at the first page whenever the filters change.
  const filterKey = JSON.stringify([search, department, status]);
  const offset = page.key === filterKey ? Math.min(page.offset, Math.max(0, Math.floor((filtered.length - 1) / PAGE_SIZE) * PAGE_SIZE)) : 0;
  const visible = filtered.slice(offset, offset + PAGE_SIZE);

  const counts = useMemo(
    () => ({
      total: users.length,
      active: users.filter((u) => u.is_active).length,
      enrolled: users.filter((u) => u.enrolled).length,
    }),
    [users]
  );

  const replace = (u: User) => setUsers((prev) => prev.map((p) => (p.id === u.id ? u : p)));

  async function setActive(user: User, active: boolean) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.patch<User>(`/users/${user.id}`, { is_active: active });
      replace(res.data);
      toast.success(active ? "Employee reactivated" : "Employee deactivated", user.full_name);
      setConfirm(null);
    } catch (err) {
      toast.error("Couldn't update employee", errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function afterClearAll(result: ClearAllResult) {
    users.forEach((u) => forgetPhoto(u.id));
    setConfirmClearAll(false);
    toast.success(
      "All data cleared",
      `${result.users_removed} employees, ${result.attendance_events} attendance records and ${result.face_samples} face samples removed.`
    );
    try {
      setUsers((await api.get<User[]>("/users")).data);
    } catch {
      setUsers((prev) =>
        prev.filter((u) => u.role === "ADMIN" || (u.role === "OPERATOR" && result.kept.operators > 0) || (u.role === "KIOSK" && (result.kept.kiosks ?? 0) > 0))
      );
    }
  }

  async function remove(user: User) {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.delete<DeleteResult>(`/users/${user.id}`);
      forgetPhoto(user.id);
      if (res?.data?.archived) {
        // Kept for payroll: deactivated, sign-in revoked, face data erased.
        replace({ ...user, is_active: false, can_login: false, enrolled: false, sample_count: 0, has_photo: false });
        toast.success("Employee archived", `${user.full_name} has attendance history, so they were deactivated and their face data erased. Attendance records are kept.`);
      } else {
        setUsers((prev) => prev.filter((p) => p.id !== user.id));
        toast.success("Employee deleted", user.full_name);
      }
      setConfirm(null);
    } catch (err) {
      toast.error("Couldn't delete employee", errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Employees"
        subtitle={`${counts.total} people · ${counts.active} active · ${counts.enrolled} face-enrolled`}
        actions={
          <div className="flex gap-2">
            {me?.role === "ADMIN" && (
              <button className="btn-ghost text-red-300 hover:text-red-200" onClick={() => setConfirmClearAll(true)}>
                <Icon name="trash" className="h-4 w-4" /> Clear all data
              </button>
            )}
            <Link to="/admin/enroll" className="btn-primary">
              <Icon name="plus" className="h-4 w-4" /> Add employee
            </Link>
          </div>
        }
      />

      <div className="card mb-4 flex flex-col gap-3 p-3 sm:flex-row sm:items-center animate-fade-up">
        <div className="relative flex-1">
          <Icon name="search" className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
          <input className="input pl-10" placeholder="Search name, ID, email, position…" aria-label="Search employees" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <select className="input sm:w-48" value={department} onChange={(e) => setDepartment(e.target.value)} aria-label="Department">
          <option value="">All departments</option>
          {departments.map((d) => (
            <option key={d}>{d}</option>
          ))}
        </select>
        <select className="input sm:w-44" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} aria-label="Status">
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Deactivated</option>
          <option value="not_enrolled">Not enrolled</option>
        </select>
      </div>

      <div className="card overflow-hidden animate-fade-up" style={{ animationDelay: "80ms" }}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[950px] table-fixed text-sm">
            <colgroup>
              <col className="w-[270px]" />
              <col className="w-[120px]" />
              <col className="w-[90px]" />
              <col className="w-[150px]" />
              <col className="w-[110px]" />
              <col className="w-[210px]" />
            </colgroup>
            <thead className="border-b border-white/[0.06] bg-white/[0.02]">
              <tr>
                <th className="table-head">Employee</th>
                <th className="table-head">Department</th>
                <th className="table-head">Role</th>
                <th className="table-head">Face</th>
                <th className="table-head">Status</th>
                <th className="table-head text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              {loading &&
                Array.from({ length: 5 }).map((_, i) => (
                  <tr key={i}>
                    <td className="table-cell" colSpan={6}>
                      <div className="skeleton h-9 w-full max-w-md" />
                    </td>
                  </tr>
                ))}
              {!loading &&
                visible.map((u) => (
                  <tr key={u.id} className={`transition-colors hover:bg-white/[0.02] ${u.is_active ? "" : "opacity-60"}`}>
                    <td className="table-cell">
                      <div className="flex items-center gap-3">
                        <Avatar userId={u.id} name={u.full_name} hasPhoto={u.has_photo} size="h-10 w-10" />
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-white">
                            {u.full_name} {u.id === me?.id && <span className="text-xs font-normal text-neutral-500">(you)</span>}
                          </p>
                          <p className="truncate text-xs text-neutral-500">
                            <span className="font-mono text-neutral-400">{u.employee_code || "—"}</span> · {u.email}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td className="table-cell">
                      <p className="truncate text-neutral-200">{u.department || "—"}</p>
                      <p className="truncate text-xs text-neutral-500">{u.position || ""}</p>
                    </td>
                    <td className="table-cell">
                      <RoleBadge role={u.role} />
                    </td>
                    <td className="table-cell">
                      {u.role === "KIOSK" ? (
                        <span className="chip bg-white/[0.06] text-neutral-400 ring-1 ring-white/10" title="Kiosk device accounts don't have a face.">
                          Device account
                        </span>
                      ) : u.enrolled ? (
                        <span className="chip bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/25">
                          <Icon name="check" className="h-3 w-3" strokeWidth={3} /> {u.sample_count} samples
                        </span>
                      ) : (
                        <Link to={`/enroll?user=${u.id}`} className="chip bg-orange-500/10 text-orange-300 ring-1 ring-orange-500/25 hover:bg-orange-500/20">
                          Not enrolled — enroll
                        </Link>
                      )}
                    </td>
                    <td className="table-cell">
                      <span className={`inline-flex items-center gap-1.5 text-xs font-semibold ${u.is_active ? "text-emerald-300" : "text-neutral-500"}`}>
                        <span className={`h-1.5 w-1.5 rounded-full ${u.is_active ? "bg-emerald-400" : "bg-neutral-600"}`} />
                        {u.is_active ? "Active" : "Deactivated"}
                      </span>
                    </td>
                    <td className="table-cell">
                      <div className="flex justify-end gap-1">
                        {u.role !== "KIOSK" && (
                          <Link
                            to={`/enroll?user=${u.id}`}
                            className="rounded-lg p-2 text-neutral-400 transition-colors hover:bg-brand-500/10 hover:text-brand-300"
                            title="Face enrollment"
                            aria-label={`Face enrollment for ${u.full_name}`}
                          >
                            <Icon name="scan" className="h-4 w-4" />
                          </Link>
                        )}
                        <button onClick={() => setEditing(u)} className="rounded-lg p-2 text-neutral-400 transition-colors hover:bg-white/10 hover:text-white" title="Edit" aria-label={`Edit ${u.full_name}`}>
                          <Icon name="edit" className="h-4 w-4" />
                        </button>
                        {u.id !== me?.id && (
                          <>
                            <button
                              onClick={() => (u.is_active ? setConfirm({ user: u, action: "deactivate" }) : setActive(u, true))}
                              disabled={busy}
                              className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-neutral-400 transition-colors hover:bg-white/10 hover:text-white"
                              aria-label={`${u.is_active ? "Deactivate" : "Reactivate"} ${u.full_name}`}
                            >
                              {u.is_active ? "Deactivate" : "Reactivate"}
                            </button>
                            <button
                              onClick={() => setConfirm({ user: u, action: "delete" })}
                              className="rounded-lg p-2 text-neutral-500 transition-colors hover:bg-red-500/10 hover:text-red-300"
                              title="Delete"
                              aria-label={`Delete ${u.full_name}`}
                            >
                              <Icon name="trash" className="h-4 w-4" />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {!loading && filtered.length === 0 && (
          <EmptyState
            icon="users"
            title={users.length ? "No employees match your filters" : "No employees yet"}
            message={users.length ? "Try a different search or filter." : "Add your first employee to start tracking attendance."}
            action={!users.length && <Link to="/admin/enroll" className="btn-primary">Add employee</Link>}
          />
        )}
        {!loading && <Pager offset={offset} pageSize={PAGE_SIZE} shown={visible.length} total={filtered.length} noun="employees" onChange={(o) => setPage({ key: filterKey, offset: o })} />}
      </div>

      {editing && <EditEmployee user={editing} isSelf={editing.id === me?.id} departments={deptList} onClose={() => setEditing(null)} onSaved={(u) => { replace(u); setEditing(null); }} />}

      <ClearAllDataDialog open={confirmClearAll} onClose={() => setConfirmClearAll(false)} onDone={afterClearAll} />

      <ConfirmDialog
        open={!!confirm}
        title={confirm?.action === "delete" ? "Delete employee?" : "Deactivate employee?"}
        danger
        busy={busy}
        confirmLabel={confirm?.action === "delete" ? "Delete employee" : "Deactivate"}
        message={
          confirm?.action === "delete" ? (
            <>
              <p>
                Delete <b className="text-white">{confirm.user.full_name}</b>?
              </p>
              <p className="mt-2">
                Employees with attendance history are <b className="text-white">archived</b>: deactivated and their face data erased; attendance records are kept for payroll.
                Employees with no attendance are deleted permanently.
              </p>
            </>
          ) : (
            <>
              <b className="text-white">{confirm?.user.full_name}</b> won't be recognized at the kiosk or able to sign in until reactivated. Attendance history is kept.
            </>
          )
        }
        onConfirm={() => confirm && (confirm.action === "delete" ? remove(confirm.user) : setActive(confirm.user, false))}
        onClose={() => !busy && setConfirm(null)}
      />
    </>
  );
}

function EditEmployee({ user, isSelf, departments, onClose, onSaved }: { user: User; isSelf: boolean; departments: Department[]; onClose: () => void; onSaved: (u: User) => void }) {
  const [form, setForm] = useState({
    full_name: user.full_name,
    employee_code: user.employee_code ?? "",
    email: user.email,
    phone: user.phone ?? "",
    department: user.department ?? "",
    position: user.position ?? "",
    role: user.role as AnyRole,
    password: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const selectedDept = departments.find((d) => d.name === form.department);

  async function save(extra: Record<string, unknown> = {}) {
    if (saving) return;
    // Only changed fields, in ONE request: a password and a role change land together or not at all.
    const original: Record<string, string> = {
      full_name: user.full_name,
      employee_code: user.employee_code ?? "",
      email: user.email,
      phone: user.phone ?? "",
      department: user.department ?? "",
      position: user.position ?? "",
      role: user.role,
    };
    const payload: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(original)) {
      const next = form[k as keyof typeof form];
      if (next !== v) payload[k] = next;
    }
    if (isSelf) delete payload.role;
    if (form.password) {
      if (form.password.length < 8 || form.password.length > 72) {
        setError("The password must be 8–72 characters.");
        return;
      }
      payload.password = form.password;
    }
    const roleNeedsPassword = form.role !== "STAFF" && form.role !== user.role && !user.can_login && !form.password;
    if (roleNeedsPassword && !extra.revoke_login) {
      setError(form.role === "KIOSK" ? "A kiosk device account needs a password to sign in on the tablet." : "Set a password: this role must be able to sign in.");
      return;
    }
    Object.assign(payload, extra);
    if (Object.keys(payload).length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await api.patch<User>(`/users/${user.id}`, payload);
      toast.success("Changes saved", res.data.full_name);
      onSaved(res.data);
    } catch (err) {
      setError(errorMessage(err, "Couldn't save changes."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title="Edit employee"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn-primary" onClick={() => save()} disabled={saving}>
            {saving && <Spinner />} Save changes
          </button>
        </>
      }
    >
      <div className="mb-5 flex items-center gap-3">
        <Avatar userId={user.id} name={user.full_name} hasPhoto={user.has_photo} size="h-12 w-12" />
        <div>
          <p className="font-semibold text-white">{user.full_name}</p>
          <p className="text-xs text-neutral-500">
            {user.role === "KIOSK" ? "Kiosk device account — runs the attendance kiosk only" : user.can_login ? "Can sign in to the web app" : "Kiosk only — no web sign-in"}
          </p>
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Full name">
          <input className="input" value={form.full_name} onChange={set("full_name")} />
        </Field>
        <Field label="Employee ID">
          <input className="input font-mono uppercase" value={form.employee_code} onChange={set("employee_code")} />
        </Field>
        <Field label="Email">
          <input className="input" type="email" value={form.email} onChange={set("email")} />
        </Field>
        <Field label="Phone">
          <input className="input" value={form.phone} onChange={set("phone")} />
        </Field>
        <Field label="Department">
          <select
            className="input"
            value={form.department}
            onChange={(e) => {
              const value = e.target.value;
              setForm((f) => ({ ...f, department: value, position: "" }));
            }}
          >
            <option value="">Select department…</option>
            {form.department && !selectedDept && <option value={form.department}>{form.department} (not in departments list)</option>}
            {departments.map((d) => (
              <option key={d.id} value={d.name}>
                {d.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Position">
          {selectedDept && selectedDept.roles.length > 0 ? (
            <select className="input" value={form.position} onChange={set("position")}>
              <option value="">Select role…</option>
              {selectedDept.roles.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          ) : (
            <input className="input" value={form.position} onChange={set("position")} />
          )}
        </Field>
        <Field label="Role" hint={isSelf ? "You can't change your own role." : ROLE_HELP[form.role]}>
          <select className="input" value={form.role} onChange={set("role")} disabled={isSelf}>
            <option value="STAFF">Staff</option>
            <option value="OPERATOR">Operator</option>
            <option value="ADMIN">Admin</option>
            <option value="KIOSK">Kiosk device</option>
          </select>
        </Field>
        <Field
          label={user.can_login ? "Reset password" : form.role === "KIOSK" ? "Device password *" : "Set password (enables sign-in)"}
          hint={user.can_login ? "Leave blank to keep unchanged. 8–72 characters." : "8–72 characters."}
        >
          <input className="input" type="password" autoComplete="new-password" maxLength={72} value={form.password} onChange={set("password")} />
        </Field>
      </div>
      {user.can_login && !isSelf && user.role === "STAFF" && (
        <button className="mt-4 text-xs font-semibold text-red-300 hover:text-red-200" onClick={() => save({ revoke_login: true })} disabled={saving}>
          Revoke web sign-in
        </button>
      )}
      {error && (
        <p role="alert" className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm text-red-300">
          {error}
        </p>
      )}
    </Modal>
  );
}
