import { useEffect, useState } from "react";
import { useUserSearch } from "../../components/admin/EmployeePicker";
import { ROLE_HELP } from "../../components/admin/roles";
import { Select } from "../../components/fields";
import Highlight from "../../components/Highlight";
import Icon from "../../components/Icon";
import SearchInput from "../../components/SearchInput";
import { Avatar, Field, Spinner } from "../../components/ui";
import api, { errorMessage } from "../../services/api";
import { toast } from "../../stores/toastStore";
import type { Department, Role, User } from "../../types";
import { smartRank } from "../../utils/search";

/* Step 1 — details (new employee) or pick an existing one */

const EMPTY_FORM = {
  full_name: "",
  employee_code: "",
  email: "",
  phone: "",
  department: "",
  position: "",
  role: "STAFF" as Role,
  allow_login: false,
  password: "",
};

export default function EmployeeStep({ onReady }: { onReady: (u: User) => void }) {
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState<Partial<Record<keyof typeof EMPTY_FORM, string>>>({});
  const [saving, setSaving] = useState(false);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [search, setSearch] = useState("");
  // Server-side search: never download the whole employee list.
  const { users, total, loading: loadingUsers, error: usersError } = useUserSearch(search, { status: "active", limit: 30, enabled: mode === "existing" });
  // Kiosk device accounts are tablets, not people: nothing to enroll.
  // The server already filtered; this only puts the best match on top (same engine as the server).
  const people = smartRank(users.filter((u) => u.role !== "KIOSK"), search, (u) => [u.full_name, u.employee_code, u.email, u.department, u.position]);

  useEffect(() => {
    api.get<Department[]>("/departments").then((r) => setDepartments(r.data)).catch(() => undefined);
    api.get("/users/next-code").then((r) => setForm((f) => (f.employee_code ? f : { ...f, employee_code: r.data.employee_code }))).catch(() => undefined);
  }, []);

  const selectedDept = departments.find((d) => d.name === form.department);

  const set = (k: keyof typeof EMPTY_FORM) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const value = e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value;
    setForm((f) => ({ ...f, [k]: value }));
    setErrors((er) => ({ ...er, [k]: undefined }));
  };

  function validate() {
    const er: typeof errors = {};
    if (!form.full_name.trim()) er.full_name = "Full name is required.";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim())) er.email = "Enter a valid email address.";
    if (form.employee_code && !/^[A-Za-z0-9._-]{1,40}$/.test(form.employee_code.trim())) er.employee_code = "Letters, numbers, dot, dash, underscore only.";
    const needsPassword = form.allow_login || form.role !== "STAFF";
    if (needsPassword && (form.password.length < 8 || form.password.length > 72)) er.password = "8–72 characters.";
    setErrors(er);
    return Object.keys(er).length === 0;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving || !validate()) return;
    setSaving(true);
    try {
      const needsPassword = form.allow_login || form.role !== "STAFF";
      const res = await api.post<User>("/users", {
        full_name: form.full_name,
        employee_code: form.employee_code || undefined,
        email: form.email,
        phone: form.phone,
        department: form.department,
        position: form.position,
        role: form.role,
        password: needsPassword ? form.password : undefined,
      });
      if (res.data.role === "KIOSK") {
        // A device account has no face to enroll: it signs in on the kiosk tablet with its password.
        toast.success("Kiosk device account created", `Sign in as ${res.data.email} on the kiosk tablet.`);
        setForm({ ...EMPTY_FORM });
        setErrors({});
        api.get("/users/next-code").then((r) => setForm((f) => (f.employee_code ? f : { ...f, employee_code: r.data.employee_code }))).catch(() => undefined);
        return;
      }
      toast.success("Employee saved", `${res.data.full_name} · ${res.data.employee_code}`);
      onReady(res.data);
    } catch (err) {
      const msg = errorMessage(err, "Couldn't save the employee.");
      if (/email/i.test(msg)) setErrors({ email: msg });
      else if (/employee id/i.test(msg)) setErrors({ employee_code: msg });
      else toast.error("Couldn't save employee", msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="panel overflow-hidden animate-fade-up sm:min-h-[46rem]">
      <div className="flex border-b border-white/[0.06]" role="tablist" aria-label="Employee">
        {(["new", "existing"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            className={`relative flex-1 px-4 py-4 text-sm font-semibold transition-colors ${mode === m ? "text-white" : "text-neutral-500 hover:text-neutral-300"}`}
          >
            {m === "new" ? "New employee" : "Existing employee"}
            <span className={`absolute inset-x-6 bottom-0 h-0.5 rounded-full bg-brand-500 transition-transform duration-300 ${mode === m ? "scale-x-100" : "scale-x-0"}`} />
          </button>
        ))}
      </div>

      {mode === "new" ? (
        <form onSubmit={submit} className="p-4 sm:p-6" noValidate>
          <h3 className="mb-1 text-sm font-bold text-brand-400">Personal information</h3>
          <p className="mb-5 text-sm text-neutral-500">Fields marked * are required.</p>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Full name *" error={errors.full_name}>
              <input className="input" value={form.full_name} onChange={set("full_name")} autoComplete="off" placeholder="Juan Dela Cruz" autoFocus />
            </Field>
            <Field label="Employee ID" hint="Auto-generated — you can change it." error={errors.employee_code}>
              <input className="input font-mono uppercase" value={form.employee_code} onChange={set("employee_code")} placeholder="EMP-0001" />
            </Field>
            <Field label="Email *" error={errors.email}>
              <input className="input" type="email" value={form.email} onChange={set("email")} autoComplete="off" placeholder="juan@company.com" />
            </Field>
            <Field label="Phone">
              <input className="input" type="tel" value={form.phone} onChange={set("phone")} placeholder="0917 123 4567" />
            </Field>
          </div>

          <h3 className="mb-4 mt-8 text-sm font-bold text-brand-400">Work information</h3>
          <div className="grid gap-5 sm:grid-cols-3">
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
                <input className="input" value={form.position} onChange={set("position")} placeholder="Line Operator" />
              )}
            </Field>
            <Field label="System role" hint={ROLE_HELP[form.role]}>
              <Select className="input" value={form.role} onChange={set("role")}>
                <option value="STAFF">Staff — clocks in only</option>
                <option value="OPERATOR">Operator — runs kiosk & reports</option>
                <option value="ADMIN">Admin — full access</option>
                <option value="KIOSK">Kiosk device — tablet sign-in only</option>
              </Select>
            </Field>
          </div>

          <div className="mt-8 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
            <label className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                className="mt-0.5 h-5 w-5 cursor-pointer rounded accent-brand-500"
                checked={form.allow_login || form.role !== "STAFF"}
                disabled={form.role !== "STAFF"}
                onChange={set("allow_login")}
              />
              <span>
                <span className="flex items-center gap-2 text-sm font-semibold text-white">
                  <Icon name="key" className="h-4 w-4 text-brand-400" /> {form.role === "KIOSK" ? "Device sign-in" : "Allow web sign-in"}
                </span>
                <span className="text-xs text-neutral-500">
                  {form.role === "KIOSK"
                    ? "Required: the kiosk tablet signs in with this email and password. It can only run the attendance kiosk."
                    : form.role !== "STAFF"
                      ? "Required for admins and operators."
                      : "Optional. Staff can view their own attendance history."}
                </span>
              </span>
            </label>
            {(form.allow_login || form.role !== "STAFF") && (
              <div className="mt-4 max-w-sm animate-fade-in">
                <Field label="Initial password *" error={errors.password} hint="Share it privately; they can use it to sign in.">
                  <input className="input" type="password" value={form.password} onChange={set("password")} autoComplete="new-password" />
                </Field>
              </div>
            )}
          </div>

          <div className="mt-8 flex justify-end">
            <button type="submit" className="btn-primary min-h-12 w-full px-6 sm:w-auto" disabled={saving}>
              {saving ? <Spinner /> : null}
              {saving ? "Saving…" : form.role === "KIOSK" ? "Create kiosk device account" : "Save & continue to face capture"}
              {!saving && <Icon name="arrow_right" className="h-4 w-4" />}
            </button>
          </div>
        </form>
      ) : (
        <div className="p-4 sm:p-6">
          <SearchInput
            className="mb-4"
            placeholder="Search by name, ID, email or department…"
            aria-label="Search employees"
            value={search}
            onValueChange={setSearch}
            autoFocus
            trailing={loadingUsers ? <Spinner className="mr-1 h-4 w-4 text-brand-400" /> : undefined}
          />
          <div className="max-h-[440px] space-y-1 overflow-y-auto" aria-busy={loadingUsers}>
            {loadingUsers && people.length === 0 && Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton h-16 w-full rounded-xl" />)}
            {!loadingUsers && people.length === 0 && (
              <p className="py-10 text-center text-sm text-neutral-500">{usersError ? "Couldn't load employees." : "No matching active employees."}</p>
            )}
            {people.map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => onReady(u)}
                className="group flex w-full items-center gap-4 rounded-xl border border-transparent p-3 text-left transition-colors hover:border-brand-500/30 hover:bg-brand-500/[0.06]"
              >
                <Avatar userId={u.id} name={u.full_name} hasPhoto={u.has_photo} size="h-11 w-11" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-white"><Highlight text={u.full_name} query={search} /></p>
                  <p className="truncate text-xs text-neutral-500"><Highlight text={[u.employee_code, u.department, u.position].filter(Boolean).join(" · ") || u.email} query={search} /></p>
                </div>
                {u.enrolled ? (
                  <span className="tag tag-ok">{u.sample_count} samples</span>
                ) : (
                  <span className="tag tag-warn">Not enrolled</span>
                )}
                <Icon name="arrow_right" className="h-4 w-4 text-neutral-600 transition-transform group-hover:translate-x-0.5 group-hover:text-brand-400" />
              </button>
            ))}
            {total > users.length && (
              <p className="px-3 py-2 text-xs text-neutral-500">
                Showing the first {users.length} of {total} — keep typing to narrow down.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
