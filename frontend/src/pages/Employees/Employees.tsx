import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import Pager from "../../components/admin/Pager";
import { AnyRole, ROLE_HELP } from "../../components/admin/roles";
import ClearAllDataDialog, { ClearAllResult } from "../../components/ClearAllDataDialog";
import Icon from "../../components/Icon";
import { useDiscardGuard } from "../../components/useDiscardGuard";
import RowMenu from "../../components/admin/RowMenu";
import { Avatar, Banner, ConfirmDialog, EmptyState, Field, IconButton, Modal, PageHeader, RoleBadge, Spinner, forgetPhoto } from "../../components/ui";
import api, { errorMessage } from "../../services/api";
import { useAuthStore } from "../../stores/authStore";
import { toast } from "../../stores/toastStore";
import type { Department, User } from "../../types";
import Highlight from "../../components/Highlight";
import SearchInput from "../../components/SearchInput";
import { smartFilter } from "../../utils/search";
import { Select } from "../../components/fields";

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

  // The list reacts to the deferred text so typing never waits on filtering; results are ranked best match first.
  const q = useDeferredValue(search);
  const filtered = useMemo(() => {
    const pool = users.filter((u) => {
      if (department && u.department !== department) return false;
      if (status === "active" && !u.is_active) return false;
      if (status === "inactive" && u.is_active) return false;
      if (status === "not_enrolled" && (u.enrolled || u.role === "KIOSK")) return false;
      return true;
    });
    return smartFilter(pool, q, (u) => [u.full_name, u.employee_code, u.email, u.department, u.position], { rank: true });
  }, [users, q, department, status]);

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
          <Link to="/admin/enroll" className="btn-primary">
            <Icon name="plus" className="h-4 w-4" /> Add employee
          </Link>
        }
      />

      <div className="bar mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <SearchInput className="flex-1" placeholder="Search name, ID, email, position…" aria-label="Search employees" value={search} onValueChange={setSearch} note={`${filtered.length} of ${users.length}`} />
        <Select className="input sm:w-48" value={department} onChange={(e) => setDepartment(e.target.value)} aria-label="Department">
          <option value="">All departments</option>
          {departments.map((d) => (
            <option key={d}>{d}</option>
          ))}
        </Select>
        <Select className="input sm:w-44" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} aria-label="Status">
          <option value="all">All statuses</option>
          <option value="active">Active</option>
          <option value="inactive">Deactivated</option>
          <option value="not_enrolled">Not enrolled</option>
        </Select>
      </div>

      <div className="panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="rtable w-full min-w-[880px] table-fixed text-sm">
            <colgroup>
              <col className="w-[270px]" />
              <col className="w-[120px]" />
              <col className="w-[90px]" />
              <col className="w-[150px]" />
              <col className="w-[110px]" />
              <col className="w-[150px]" />
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
                  <tr
                    key={u.id}
                    className={`cursor-pointer transition-colors hover:bg-white/[0.02] ${u.is_active ? "" : "opacity-60"}`}
                    onClick={(e) => {
                      // The whole row opens the editor; buttons and links inside it keep their own meaning.
                      if (!(e.target as HTMLElement).closest("a, button, [role=menu]")) setEditing(u);
                    }}
                  >
                    <td className="table-cell cell-primary">
                      <div className="flex items-center gap-3">
                        <Avatar userId={u.id} name={u.full_name} hasPhoto={u.has_photo} size="h-10 w-10" />
                        <div className="min-w-0">
                          <p className="truncate font-semibold text-white">
                            <Highlight text={u.full_name} query={q} /> {u.id === me?.id && <span className="text-xs font-normal text-neutral-400">(you)</span>}
                          </p>
                          <p className="truncate text-xs text-neutral-400">
                            <span className="font-mono text-neutral-400">{u.employee_code ? <Highlight text={u.employee_code} query={q} /> : "—"}</span> · {u.email}
                          </p>
                        </div>
                      </div>
                    </td>
                    <td data-label="Department" className="table-cell">
                      <p className="truncate text-neutral-200">{u.department ? <Highlight text={u.department} query={q} /> : "—"}</p>
                      <p className="truncate text-xs text-neutral-400">{u.position || ""}</p>
                    </td>
                    <td data-label="Role" className="table-cell">
                      <RoleBadge role={u.role} />
                    </td>
                    <td data-label="Face" className="table-cell">
                      {u.role === "KIOSK" ? (
                        <span className="tag tag-dot tag-muted" title="Kiosk device accounts don't have a face.">
                          Device account
                        </span>
                      ) : u.enrolled ? (
                        <span className="tag tag-ok">
                          <Icon name="check" className="h-3.5 w-3.5" strokeWidth={2.4} /> {u.sample_count} samples
                        </span>
                      ) : (
                        <Link to={`/admin/enroll?user=${u.id}`} className="tag tag-dot tag-warn hover:underline">
                          Not enrolled — enroll
                        </Link>
                      )}
                    </td>
                    <td data-label="Status" className="table-cell">
                      <span className={`tag tag-dot ${u.is_active ? "tag-ok" : "tag-muted"}`}>
                        {u.is_active ? "Active" : "Deactivated"}
                      </span>
                    </td>
                    <td className="table-cell cell-actions">
                      <div className="flex items-center justify-end gap-1">
                        {u.role !== "KIOSK" && (
                          <Link
                            to={`/admin/enroll?user=${u.id}`}
                            className="inline-grid h-10 w-10 place-items-center rounded-lg text-neutral-300 transition-colors hover:bg-brand-500/10 hover:text-brand-300"
                            title="Face enrollment"
                            aria-label={`Face enrollment for ${u.full_name}`}
                          >
                            <Icon name="scan" className="h-4 w-4" />
                          </Link>
                        )}
                        <IconButton onClick={() => setEditing(u)} label={`Edit ${u.full_name}`}>
                          <Icon name="edit" className="h-4 w-4" />
                        </IconButton>
                        {u.id !== me?.id && (
                          <RowMenu
                            label={`More actions for ${u.full_name}`}
                            items={[
                              {
                                label: u.is_active ? "Deactivate" : "Reactivate",
                                ariaLabel: `${u.is_active ? "Deactivate" : "Reactivate"} ${u.full_name}`,
                                disabled: busy,
                                onSelect: () => (u.is_active ? setConfirm({ user: u, action: "deactivate" }) : setActive(u, true)),
                              },
                              {
                                label: "Delete…",
                                ariaLabel: `Delete ${u.full_name}`,
                                danger: true,
                                icon: <Icon name="trash" className="h-4 w-4" />,
                                onSelect: () => setConfirm({ user: u, action: "delete" }),
                              },
                            ]}
                          />
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

      {me?.role === "ADMIN" && (
        <section className="mt-10 border-t border-red-500/30 pt-5" aria-labelledby="danger-zone">
          <h2 id="danger-zone" className="text-sm font-semibold text-red-300">Danger zone</h2>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="max-w-xl text-sm text-neutral-400">Remove every employee, attendance record and face sample from this system. This cannot be undone.</p>
            <button className="btn-danger shrink-0" onClick={() => setConfirmClearAll(true)}>
              <Icon name="trash" className="h-4 w-4" /> Clear all data
            </button>
          </div>
        </section>
      )}

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
  const [pending, setPending] = useState<{ extra: Record<string, unknown>; title: string; confirmLabel: string; lines: string[] } | null>(null);
  const dirty =
    form.password !== "" ||
    form.full_name !== user.full_name ||
    form.employee_code !== (user.employee_code ?? "") ||
    form.email !== user.email ||
    form.phone !== (user.phone ?? "") ||
    form.department !== (user.department ?? "") ||
    form.position !== (user.position ?? "") ||
    form.role !== user.role;
  const { requestClose, dialog: discardDialog } = useDiscardGuard(dirty, onClose, saving);

  /** Why this form can't be saved yet, or null. Checked before anything is confirmed or sent. */
  function problemWith(extra: Record<string, unknown>) {
    if (form.password && (form.password.length < 8 || form.password.length > 72)) return "The password must be 8–72 characters.";
    const roleNeedsPassword = form.role !== "STAFF" && form.role !== user.role && !user.can_login && !form.password;
    if (roleNeedsPassword && !extra.revoke_login) return form.role === "KIOSK" ? "A kiosk device account needs a password to sign in on the tablet." : "Set a password: this role must be able to sign in.";
    return null;
  }

  /** Role, password and sign-in changes are security-sensitive: they are listed and confirmed before they are sent. */
  function review(extra: Record<string, unknown> = {}) {
    const problem = problemWith(extra);
    if (problem) return setError(problem);
    const lines: string[] = [];
    if (!isSelf && form.role !== user.role) lines.push(`Role: ${user.role.toLowerCase()} → ${form.role.toLowerCase()}${form.role === "ADMIN" ? " (full admin access)" : ""}`);
    if (form.password) lines.push("Set a new password (their current one stops working)");
    if (extra.revoke_login) lines.push("Remove their web sign-in (they can still use the kiosk)");
    if (lines.length === 0) return void save(extra);
    setPending({ extra, lines, title: extra.revoke_login ? "Revoke web sign-in?" : "Confirm sensitive changes", confirmLabel: extra.revoke_login ? "Revoke sign-in" : "Apply changes" });
  }

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
    const problem = problemWith(extra);
    if (problem) {
      setError(problem);
      return;
    }
    if (form.password) payload.password = form.password;
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
      onClose={requestClose}
      title="Edit employee"
      footer={
        <>
          <button className="btn-ghost" onClick={requestClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn-primary" onClick={() => review()} disabled={saving}>
            {saving && <Spinner />} Save changes
          </button>
        </>
      }
    >
      <div className="mb-5 flex items-center gap-3">
        <Avatar userId={user.id} name={user.full_name} hasPhoto={user.has_photo} size="h-12 w-12" />
        <div>
          <p className="font-semibold text-white">{user.full_name}</p>
          <p className="text-xs text-neutral-400">
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
          <Select
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
          </Select>
        </Field>
        <Field label="Position">
          {selectedDept && selectedDept.roles.length > 0 ? (
            <Select className="input" value={form.position} onChange={set("position")}>
              <option value="">Select role…</option>
              {selectedDept.roles.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </Select>
          ) : (
            <input className="input" value={form.position} onChange={set("position")} />
          )}
        </Field>
        <Field label="Role" hint={isSelf ? "You can't change your own role." : ROLE_HELP[form.role]}>
          <Select className="input" value={form.role} onChange={set("role")} disabled={isSelf}>
            <option value="STAFF">Staff</option>
            <option value="OPERATOR">Operator</option>
            <option value="ADMIN">Admin</option>
            <option value="KIOSK">Kiosk device</option>
          </Select>
        </Field>
        <Field
          label={user.can_login ? "Reset password" : form.role === "KIOSK" ? "Device password *" : "Set password (enables sign-in)"}
          hint={user.can_login ? "Leave blank to keep unchanged. 8–72 characters." : "8–72 characters."}
        >
          <input className="input" type="password" autoComplete="new-password" maxLength={72} value={form.password} onChange={set("password")} />
        </Field>
      </div>
      {user.can_login && !isSelf && user.role === "STAFF" && (
        <button className="mt-4 text-xs font-semibold text-red-300 hover:text-red-200" onClick={() => review({ revoke_login: true })} disabled={saving}>
          Revoke web sign-in
        </button>
      )}
      {error && (
        <Banner tone="error" className="mt-4">{error}</Banner>
      )}
      {discardDialog}
      <ConfirmDialog
        open={!!pending}
        title={pending?.title ?? ""}
        confirmLabel={pending?.confirmLabel}
        danger={!!pending?.extra.revoke_login}
        busy={saving}
        message={
          <>
            <p>
              For <b className="text-white">{user.full_name}</b>:
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5">{pending?.lines.map((l) => <li key={l}>{l}</li>)}</ul>
          </>
        }
        onClose={() => !saving && setPending(null)}
        onConfirm={async () => {
          const extra = pending?.extra ?? {};
          await save(extra);
          setPending(null);
        }}
      />
    </Modal>
  );
}
