import { useCallback, useEffect, useMemo, useState } from "react";
import Icon from "../../components/Icon";
import { Avatar, ConfirmDialog, EmptyState, EventBadge, Field, Modal, PageHeader, Spinner, formatTime } from "../../components/ui";
import api, { downloadFile, errorMessage } from "../../services/api";
import { useAuthStore } from "../../stores/authStore";
import { toast } from "../../stores/toastStore";
import type { AttendanceEvent, DailyRow, User } from "../../types";
import { smartMatch } from "../../utils/search";

function ymd(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function preset(kind: "today" | "yesterday" | "week" | "month"): [string, string] {
  const now = new Date();
  if (kind === "today") return [ymd(now), ymd(now)];
  if (kind === "yesterday") {
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    return [ymd(y), ymd(y)];
  }
  if (kind === "week") {
    const start = new Date(now);
    start.setDate(now.getDate() - ((now.getDay() + 6) % 7)); // Monday
    return [ymd(start), ymd(now)];
  }
  return [ymd(new Date(now.getFullYear(), now.getMonth(), 1)), ymd(now)];
}

const PRESETS = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
] as const;

function hoursLabel(h: number) {
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  return `${hh}h ${String(mm).padStart(2, "0")}m`;
}

export default function Records() {
  const user = useAuthStore((s) => s.user);
  const isStaff = user?.role === "STAFF";
  const isAdmin = user?.role === "ADMIN";
  const [tab, setTab] = useState<"timesheet" | "log">(isStaff ? "log" : "timesheet");
  const [[from, to], setRange] = useState<[string, string]>(preset(isStaff ? "month" : "today"));
  const [department, setDepartment] = useState("");
  const [departments, setDepartments] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [daily, setDaily] = useState<DailyRow[]>([]);
  const [events, setEvents] = useState<AttendanceEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [deleting, setDeleting] = useState<AttendanceEvent | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isStaff) api.get<string[]>("/users/departments").then((r) => setDepartments(r.data)).catch(() => undefined);
  }, [isStaff]);

  const params = useMemo(() => ({ from, to, department: department || undefined }), [from, to, department]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (tab === "timesheet") setDaily((await api.get<DailyRow[]>("/reports/daily", { params })).data);
      else setEvents((await api.get<AttendanceEvent[]>("/attendance", { params: { ...params, limit: 1000 } })).data);
    } catch (err) {
      toast.error("Couldn't load records", errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [tab, params]);

  useEffect(() => {
    load();
  }, [load]);

  const dailyRows = daily.filter((r) => smartMatch(search, [r.user_name, r.employee_code, r.department]));
  const eventRows = events.filter((e) => smartMatch(search, [e.user_name, e.employee_code, e.department]));

  const totals = useMemo(
    () => ({
      people: new Set(dailyRows.map((r) => r.user_id)).size,
      hours: dailyRows.reduce((s, r) => s + r.hours, 0),
      otHours: dailyRows.reduce((s, r) => s + (r.ot_hours || 0), 0),
      late: dailyRows.filter((r) => r.late).length,
    }),
    [dailyRows]
  );

  async function exportCsv() {
    setExporting(true);
    try {
      await downloadFile("/reports/export.csv", params, `attendance_${from}_${to}.csv`);
      toast.success("Export ready", "CSV downloaded — opens in Excel.");
    } catch (err) {
      toast.error("Export failed", errorMessage(err));
    } finally {
      setExporting(false);
    }
  }

  async function deleteEvent(e: AttendanceEvent) {
    setBusy(true);
    try {
      await api.delete(`/attendance/${e.id}`);
      setEvents((prev) => prev.filter((p) => p.id !== e.id));
      toast.success("Record deleted", "The change was written to the audit log.");
      setDeleting(null);
    } catch (err) {
      toast.error("Couldn't delete record", errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const activePreset = PRESETS.find((p) => {
    const [a, b] = preset(p.key);
    return a === from && b === to;
  })?.key;

  return (
    <>
      <PageHeader
        title={isStaff ? "My attendance" : "Attendance records"}
        subtitle={isStaff ? "Your clock-in and clock-out history." : "Timesheets, raw scan logs and exports."}
        actions={
          !isStaff && (
            <>
              {isAdmin && (
                <button className="btn-ghost" onClick={() => setManualOpen(true)}>
                  <Icon name="plus" className="h-4 w-4" /> Manual entry
                </button>
              )}
              <button className="btn-primary" onClick={exportCsv} disabled={exporting}>
                {exporting ? <Spinner /> : <Icon name="download" className="h-4 w-4" />} Export CSV
              </button>
            </>
          )
        }
      />

      <div className="card mb-4 space-y-3 p-3 animate-fade-up">
        <div className="flex flex-wrap items-center gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              onClick={() => setRange(preset(p.key))}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${activePreset === p.key ? "bg-brand-500 text-black" : "bg-white/[0.04] text-neutral-300 hover:bg-white/[0.08]"}`}
            >
              {p.label}
            </button>
          ))}
          <div className="flex items-center gap-2">
            <input type="date" className="input w-auto py-1.5" value={from} max={to} onChange={(e) => setRange([e.target.value, to])} aria-label="From" />
            <span className="text-neutral-500">→</span>
            <input type="date" className="input w-auto py-1.5" value={to} min={from} onChange={(e) => setRange([from, e.target.value])} aria-label="To" />
          </div>
        </div>
        {!isStaff && (
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative flex-1">
              <Icon name="search" className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
              <input className="input pl-10" placeholder="Filter by employee name or ID…" value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <select className="input sm:w-52" value={department} onChange={(e) => setDepartment(e.target.value)} aria-label="Department">
              <option value="">All departments</option>
              {departments.map((d) => (
                <option key={d}>{d}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {!isStaff && (
        <div className="mb-4 flex gap-1 rounded-xl border border-white/10 bg-white/[0.03] p-1 sm:w-fit animate-fade-up">
          {(["timesheet", "log"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`flex-1 rounded-lg px-4 py-2 text-sm font-semibold transition-all sm:flex-none ${tab === t ? "bg-brand-500 text-black" : "text-neutral-400 hover:text-white"}`}
            >
              {t === "timesheet" ? "Timesheet" : "Scan log"}
            </button>
          ))}
        </div>
      )}

      {tab === "timesheet" && !isStaff ? (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 animate-fade-up sm:grid-cols-4">
            {[
              ["Employees", String(totals.people)],
              ["Hours worked", hoursLabel(totals.hours)],
              ["OT hours", hoursLabel(totals.otHours)],
              ["Late arrivals", String(totals.late)],
            ].map(([k, v]) => (
              <div key={k} className="card border border-brand-500/30 px-4 py-3 transition-colors duration-200 hover:border-brand-500/50">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">{k}</p>
                <p className="mt-0.5 text-xl font-extrabold tabular-nums text-white">{loading ? "—" : v}</p>
              </div>
            ))}
          </div>
          <div className="card overflow-hidden animate-fade-up">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[820px] table-fixed text-sm">
                <colgroup>
                  <col className="w-[140px]" />
                  <col className="w-[220px]" />
                  <col className="w-[110px]" />
                  <col className="w-[110px]" />
                  <col className="w-[90px]" />
                  <col className="w-[80px]" />
                  <col className="w-[120px]" />
                </colgroup>
                <thead className="border-b border-white/[0.06] bg-white/[0.02]">
                  <tr>
                    <th className="table-head">Date</th>
                    <th className="table-head">Employee</th>
                    <th className="table-head">Time in</th>
                    <th className="table-head">Time out</th>
                    <th className="table-head">Hours</th>
                    <th className="table-head">OT</th>
                    <th className="table-head">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04]">
                  {loading && <SkeletonRows cols={7} />}
                  {!loading &&
                    dailyRows.map((r) => (
                      <tr key={`${r.user_id}-${r.date}`} className="hover:bg-white/[0.02]">
                        <td className="table-cell whitespace-nowrap text-neutral-400">{new Date(r.date + "T00:00").toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}</td>
                        <td className="table-cell">
                          <p className="font-semibold text-white">{r.user_name}</p>
                          <p className="text-xs text-neutral-500">{[r.employee_code, r.department].filter(Boolean).join(" · ")}</p>
                        </td>
                        <td className="table-cell tabular-nums text-neutral-200">{formatTime(r.first_in)}</td>
                        <td className="table-cell tabular-nums text-neutral-200">{r.last_out ? formatTime(r.last_out) : r.open ? <span className="text-emerald-300">On site</span> : "—"}</td>
                        <td className="table-cell font-semibold tabular-nums text-white">{hoursLabel(r.hours)}</td>
                        <td className="table-cell tabular-nums text-neutral-300">{r.ot_hours ? hoursLabel(r.ot_hours) : "—"}</td>
                        <td className="table-cell">
                          {r.late ? (
                            <span className="chip bg-orange-500/10 text-orange-300 ring-1 ring-orange-500/25">Late</span>
                          ) : r.first_in ? (
                            <span className="chip bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/25">On time</span>
                          ) : (
                            <span className="chip bg-white/[0.06] text-neutral-400">No clock-in</span>
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            {!loading && dailyRows.length === 0 && <EmptyState icon="records" title="No attendance in this range" message="Pick a different date range or department." />}
          </div>
        </>
      ) : (
        <div className="card overflow-hidden animate-fade-up">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] table-fixed text-sm">
              <colgroup>
                <col className="w-[140px]" />
                {!isStaff && <col className="w-[220px]" />}
                <col className="w-[160px]" />
                <col className="w-[160px]" />
                <col className="w-[140px]" />
                {isAdmin && <col className="w-[60px]" />}
              </colgroup>
              <thead className="border-b border-white/[0.06] bg-white/[0.02]">
                <tr>
                  <th className="table-head">When</th>
                  {!isStaff && <th className="table-head">Employee</th>}
                  <th className="table-head">Event</th>
                  <th className="table-head">Method</th>
                  <th className="table-head">Device</th>
                  {isAdmin && <th className="table-head" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {loading && <SkeletonRows cols={isStaff ? 4 : 6} />}
                {!loading &&
                  eventRows.map((e) => (
                    <tr key={e.id} className="hover:bg-white/[0.02]">
                      <td className="table-cell whitespace-nowrap">
                        <p className="font-semibold tabular-nums text-white">{formatTime(e.timestamp)}</p>
                        <p className="text-xs text-neutral-500">{new Date(e.timestamp).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}</p>
                      </td>
                      {!isStaff && (
                        <td className="table-cell">
                          <div className="flex items-center gap-3">
                            <Avatar userId={e.user_id} name={e.user_name} hasPhoto={e.has_photo} size="h-8 w-8" text="text-[10px]" />
                            <div className="min-w-0">
                              <p className="truncate font-semibold text-white">{e.user_name}</p>
                              <p className="truncate text-xs text-neutral-500">{[e.employee_code, e.department].filter(Boolean).join(" · ")}</p>
                            </div>
                          </div>
                        </td>
                      )}
                      <td className="table-cell">
                        <EventBadge type={e.event_type} session={e.session} late={e.is_late} lateMinutes={e.late_minutes} earlyMinutes={e.early_minutes} />
                      </td>
                      <td className="table-cell text-xs">
                        {e.match_status === "MANUAL" ? (
                          <span className="text-orange-300" title={e.notes ?? ""}>
                            Manual{e.notes ? ` — ${e.notes.replace(/^Manual:\s*/, "")}` : ""}
                          </span>
                        ) : (
                          <span className="text-neutral-300">
                            Face · <span className="tabular-nums">{(e.match_score * 100).toFixed(0)}%</span>
                            {e.liveness_passed && <span className="text-neutral-500"> · live</span>}
                          </span>
                        )}
                      </td>
                      <td className="table-cell font-mono text-xs text-neutral-500">{e.device_id || "—"}</td>
                      {isAdmin && (
                        <td className="table-cell text-right">
                          <button onClick={() => setDeleting(e)} className="rounded-lg p-2 text-neutral-500 hover:bg-red-500/10 hover:text-red-300" title="Delete record">
                            <Icon name="trash" className="h-4 w-4" />
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          {!loading && eventRows.length === 0 && <EmptyState icon="scan" title="No scans in this range" message="Try a wider date range." />}
        </div>
      )}

      {manualOpen && <ManualEntry onClose={() => setManualOpen(false)} onSaved={() => { setManualOpen(false); load(); }} />}

      <ConfirmDialog
        open={!!deleting}
        title="Delete attendance record?"
        danger
        busy={busy}
        confirmLabel="Delete"
        message={
          <>
            Remove the {deleting?.event_type === "CLOCK_IN" ? "clock-in" : "clock-out"} for <b className="text-white">{deleting?.user_name}</b> at {formatTime(deleting?.timestamp)}? This is recorded in the audit log.
          </>
        }
        onConfirm={() => deleting && deleteEvent(deleting)}
        onClose={() => setDeleting(null)}
      />
    </>
  );
}

function SkeletonRows({ cols }: { cols: number }) {
  return (
    <>
      {Array.from({ length: 6 }).map((_, i) => (
        <tr key={i}>
          {Array.from({ length: cols }).map((__, j) => (
            <td key={j} className="table-cell">
              <div className="skeleton h-4 w-full max-w-[120px]" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

function ManualEntry({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [users, setUsers] = useState<User[]>([]);
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const [form, setForm] = useState({ user_id: "", event_type: "CLOCK_IN", session: "", timestamp: local, notes: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<User[]>("/users", { params: { status: "active" } }).then((r) => setUsers(r.data)).catch(() => undefined);
  }, []);

  async function save() {
    if (!form.user_id || !form.notes.trim()) {
      setError("Choose an employee and give a reason.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.post("/attendance", { ...form, timestamp: new Date(form.timestamp).toISOString() });
      toast.success("Manual entry saved", "Recorded in the audit log.");
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Manual attendance entry"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" onClick={save} disabled={saving}>
            {saving && <Spinner />} Save entry
          </button>
        </>
      }
    >
      <p className="mb-4 rounded-xl bg-brand-500/10 px-3 py-2 text-xs text-brand-200">
        Use only when the kiosk couldn't be used (camera down, injury, etc.). Every manual entry is audited.
      </p>
      <div className="space-y-4">
        <Field label="Employee">
          <select className="input" value={form.user_id} onChange={(e) => setForm({ ...form, user_id: e.target.value })}>
            <option value="">Select employee…</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.full_name} {u.employee_code ? `(${u.employee_code})` : ""}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Event">
            <select className="input" value={form.event_type} onChange={(e) => setForm({ ...form, event_type: e.target.value })}>
              <option value="CLOCK_IN">Clock in</option>
              <option value="CLOCK_OUT">Clock out</option>
            </select>
          </Field>
          <Field label="Session">
            <select className="input" value={form.session} onChange={(e) => setForm({ ...form, session: e.target.value })}>
              <option value="">Auto (from time)</option>
              <option value="AM">AM</option>
              <option value="PM">PM</option>
              <option value="OT">OT</option>
            </select>
          </Field>
        </div>
        <Field label="Date & time">
          <input type="datetime-local" className="input" value={form.timestamp} onChange={(e) => setForm({ ...form, timestamp: e.target.value })} />
        </Field>
        <Field label="Reason">
          <input className="input" value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="e.g. Kiosk camera offline" />
        </Field>
        {error && <p className="text-sm text-red-300">{error}</p>}
      </div>
    </Modal>
  );
}
