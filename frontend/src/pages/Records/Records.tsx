import { useCallback, useEffect, useMemo, useState } from "react";
import EmployeePicker, { PickedEmployee } from "../../components/admin/EmployeePicker";
import Pager from "../../components/admin/Pager";
import Tabs, { tabPanelProps } from "../../components/admin/Tabs";
import { cleanParams, isCancelled, totalCount, useLatestRequest } from "../../components/admin/request";
import Icon from "../../components/Icon";
import { Avatar, ConfirmDialog, EmptyState, EventBadge, Field, Modal, PageHeader, Spinner, formatMinutes } from "../../components/ui";
import api, { downloadFile, errorMessage } from "../../services/api";
import { useAuthStore } from "../../stores/authStore";
import { toast } from "../../stores/toastStore";
import type { AttendanceEvent, DailyRow } from "../../types";
import { datetimeLocalToApi, formatDate, formatTime, orgDate, orgMonthStart, toDatetimeLocal } from "../../utils/orgTime";
import { smartMatch } from "../../utils/search";

type EventRow = AttendanceEvent;
/** Daily-report fields added by the backend (row `date` is the shift's work day). */
type DayRow = DailyRow;

type PresetKey = "today" | "yesterday" | "week" | "month";

/** Date presets in the organisation's timezone, not the browser's. */
function preset(kind: PresetKey): [string, string] {
  const today = orgDate(0);
  if (kind === "today") return [today, today];
  if (kind === "yesterday") {
    const y = orgDate(-1);
    return [y, y];
  }
  if (kind === "week") {
    const weekday = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday
    return [orgDate(-((weekday + 6) % 7)), today]; // Monday
  }
  return [orgMonthStart(), today];
}

const PRESETS = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
] as const;

const PAGE_SIZE = 100;
const SHORT_DATE: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric" };

function hoursLabel(h: number) {
  let hh = Math.floor(h);
  let mm = Math.round((h - hh) * 60);
  if (mm === 60) {
    hh += 1;
    mm = 0;
  }
  return `${hh}h ${String(mm).padStart(2, "0")}m`;
}

function eventLabel(e: Pick<AttendanceEvent, "event_type">) {
  return e.event_type === "CLOCK_IN" ? "clock-in" : "clock-out";
}

export default function Records() {
  const user = useAuthStore((s) => s.user);
  const isStaff = user?.role === "STAFF";
  const isAdmin = user?.role === "ADMIN";
  const [tab, setTab] = useState<"timesheet" | "log">(isStaff ? "log" : "timesheet");
  const [[from, to], setRange] = useState<[string, string]>(() => preset(isStaff ? "month" : "today"));
  const [department, setDepartment] = useState("");
  const [departments, setDepartments] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [employee, setEmployee] = useState<PickedEmployee | null>(null);
  const [daily, setDaily] = useState<DayRow[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [editing, setEditing] = useState<EventRow | null>(null);
  const [deleting, setDeleting] = useState<EventRow | null>(null);
  const [busy, setBusy] = useState(false);
  const begin = useLatestRequest();

  useEffect(() => {
    if (!isStaff) api.get<string[]>("/users/departments").then((r) => setDepartments(r.data)).catch(() => undefined);
  }, [isStaff]);

  const params = useMemo(() => cleanParams({ from, to, department }), [from, to, department]);

  // The page offset belongs to one set of filters: any filter/tab change starts at the first page
  // again without an extra render-and-reload cycle.
  const filterKey = JSON.stringify([tab, params, employee?.id ?? null]);
  const [page, setPage] = useState({ key: filterKey, offset: 0 });
  const offset = page.key === filterKey ? page.offset : 0;

  const load = useCallback(async () => {
    const req = begin();
    setLoading(true);
    try {
      if (tab === "timesheet") {
        const res = await api.get<DayRow[]>("/reports/daily", { params, signal: req.signal });
        if (!req.isCurrent()) return;
        setDaily(res.data);
      } else {
        const res = await api.get<EventRow[]>("/attendance", {
          params: { ...params, ...(employee ? { user_id: employee.id } : {}), limit: PAGE_SIZE, offset },
          signal: req.signal,
        });
        if (!req.isCurrent()) return;
        setEvents(res.data);
        setTotal(totalCount(res.headers, offset + res.data.length));
      }
    } catch (err) {
      if (!req.isCurrent() || isCancelled(err)) return;
      toast.error("Couldn't load records", errorMessage(err));
    } finally {
      if (req.isCurrent()) setLoading(false);
    }
  }, [tab, params, offset, employee, begin]);

  useEffect(() => {
    load();
  }, [load]);

  const dailyRows = daily.filter((r) => smartMatch(search, [r.user_name, r.employee_code, r.department]));
  // Operators can't use the employee picker (it needs the admin-only user list), so their
  // text filter narrows the page that is loaded.
  const pageFilter = !isAdmin && !isStaff;
  const eventRows = pageFilter ? events.filter((e) => smartMatch(search, [e.user_name, e.employee_code, e.department])) : events;

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
      await downloadFile("/reports/export.csv", params, `attendance_${from || "all"}_${to || "all"}.csv`);
      toast.success("Export ready", "CSV downloaded — opens in Excel.");
    } catch (err) {
      toast.error("Export failed", errorMessage(err));
    } finally {
      setExporting(false);
    }
  }

  async function deleteEvent(e: EventRow) {
    if (busy) return;
    setBusy(true);
    try {
      await api.delete(`/attendance/${e.id}`);
      setEvents((prev) => prev.filter((p) => p.id !== e.id));
      setTotal((t) => Math.max(0, t - 1));
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

  const showSearch = !isStaff && (tab === "timesheet" || !isAdmin);

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
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Date range">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              aria-pressed={activePreset === p.key}
              onClick={() => setRange(preset(p.key))}
              className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${activePreset === p.key ? "bg-brand-500 text-black" : "bg-white/[0.04] text-neutral-300 hover:bg-white/[0.08]"}`}
            >
              {p.label}
            </button>
          ))}
          <div className="flex items-center gap-2">
            <input type="date" className="input w-auto py-1.5" value={from} max={to || undefined} onChange={(e) => setRange([e.target.value, to])} aria-label="From date" />
            <span className="text-neutral-500" aria-hidden="true">→</span>
            <input type="date" className="input w-auto py-1.5" value={to} min={from || undefined} onChange={(e) => setRange([from, e.target.value])} aria-label="To date" />
          </div>
        </div>
        {!isStaff && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            {showSearch && (
              <div className="relative flex-1">
                <Icon name="search" className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
                <input
                  className="input pl-10"
                  placeholder={tab === "log" ? "Filter this page by name or ID…" : "Filter by employee name or ID…"}
                  aria-label="Filter by employee"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            )}
            {tab === "log" && isAdmin && (
              <div className="flex-1">
                <EmployeePicker label="Employee" value={employee} onChange={setEmployee} status="all" placeholder="All employees — search to filter…" />
              </div>
            )}
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
        <Tabs
          label="Record view"
          idPrefix="records"
          value={tab}
          onChange={setTab}
          tabs={[
            { key: "timesheet", label: "Timesheet" },
            { key: "log", label: "Scan log" },
          ]}
        />
      )}

      {tab === "timesheet" && !isStaff ? (
        <div {...tabPanelProps("records", "timesheet")}>
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
              <table className="w-full min-w-[860px] table-fixed text-sm">
                <colgroup>
                  <col className="w-[140px]" />
                  <col className="w-[220px]" />
                  <col className="w-[110px]" />
                  <col className="w-[110px]" />
                  <col className="w-[90px]" />
                  <col className="w-[80px]" />
                  <col className="w-[160px]" />
                </colgroup>
                <thead className="border-b border-white/[0.06] bg-white/[0.02]">
                  <tr>
                    <th className="table-head">Work day</th>
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
                        <td className="table-cell whitespace-nowrap text-neutral-400">{formatDate(r.date, SHORT_DATE)}</td>
                        <td className="table-cell">
                          <p className="font-semibold text-white">{r.user_name}</p>
                          <p className="text-xs text-neutral-500">{[r.employee_code, r.department].filter(Boolean).join(" · ")}</p>
                        </td>
                        <td className="table-cell tabular-nums text-neutral-200">
                          <TimeWithDay iso={r.first_in} workDate={r.date} />
                        </td>
                        <td className="table-cell tabular-nums text-neutral-200">
                          {r.last_out ? <TimeWithDay iso={r.last_out} workDate={r.date} /> : r.open ? <span className="text-emerald-300">On site</span> : "—"}
                        </td>
                        <td className="table-cell font-semibold tabular-nums text-white">{hoursLabel(r.hours)}</td>
                        <td className="table-cell tabular-nums text-neutral-300">{r.ot_hours ? hoursLabel(r.ot_hours) : "—"}</td>
                        <td className="table-cell">
                          <div className="flex flex-wrap gap-1">
                            {r.late ? (
                              <span className="chip bg-orange-500/10 text-orange-300 ring-1 ring-orange-500/25">Late{r.late_minutes ? ` ${formatMinutes(r.late_minutes)}` : ""}</span>
                            ) : r.first_in ? (
                              <span className="chip bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/25">On time</span>
                            ) : (
                              <span className="chip bg-white/[0.06] text-neutral-400">No clock-in</span>
                            )}
                            {r.early_leave && (
                              <span className="chip bg-sky-500/10 text-sky-300 ring-1 ring-sky-500/25">Left early{r.early_minutes ? ` ${formatMinutes(r.early_minutes)}` : ""}</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            {!loading && dailyRows.length === 0 && <EmptyState icon="records" title="No attendance in this range" message="Pick a different date range or department." />}
          </div>
        </div>
      ) : (
        <div className="card overflow-hidden animate-fade-up" {...(isStaff ? {} : tabPanelProps("records", "log"))}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] table-fixed text-sm">
              <colgroup>
                <col className="w-[150px]" />
                {!isStaff && <col className="w-[220px]" />}
                <col className="w-[160px]" />
                <col className="w-[160px]" />
                <col className="w-[140px]" />
                {isAdmin && <col className="w-[96px]" />}
              </colgroup>
              <thead className="border-b border-white/[0.06] bg-white/[0.02]">
                <tr>
                  <th className="table-head">When</th>
                  {!isStaff && <th className="table-head">Employee</th>}
                  <th className="table-head">Event</th>
                  <th className="table-head">Method</th>
                  <th className="table-head">Device</th>
                  {isAdmin && (
                    <th className="table-head">
                      <span className="sr-only">Actions</span>
                    </th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {loading && <SkeletonRows cols={(isStaff ? 4 : 5) + (isAdmin ? 1 : 0)} />}
                {!loading &&
                  eventRows.map((e) => {
                    const calendarDay = toDatetimeLocal(e.timestamp).slice(0, 10);
                    const otherWorkDay = e.work_date && e.work_date !== calendarDay ? e.work_date : null;
                    return (
                      <tr key={e.id} className="hover:bg-white/[0.02]">
                        <td className="table-cell whitespace-nowrap">
                          <p className="font-semibold tabular-nums text-white">{formatTime(e.timestamp)}</p>
                          <p className="text-xs text-neutral-500">{formatDate(e.timestamp, SHORT_DATE)}</p>
                          {otherWorkDay && (
                            <p className="text-[11px] text-sky-300" title="Night shift: this punch counts toward the shift that started on this day.">
                              Work day {formatDate(otherWorkDay, { month: "short", day: "numeric" })}
                            </p>
                          )}
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
                            <div className="flex justify-end gap-1">
                              <button
                                onClick={() => setEditing(e)}
                                className="rounded-lg p-2 text-neutral-500 hover:bg-white/10 hover:text-white"
                                title="Correct record"
                                aria-label={`Correct ${eventLabel(e)} for ${e.user_name ?? "employee"} at ${formatTime(e.timestamp)}`}
                              >
                                <Icon name="edit" className="h-4 w-4" />
                              </button>
                              <button
                                onClick={() => setDeleting(e)}
                                className="rounded-lg p-2 text-neutral-500 hover:bg-red-500/10 hover:text-red-300"
                                title="Delete record"
                                aria-label={`Delete ${eventLabel(e)} for ${e.user_name ?? "employee"} at ${formatTime(e.timestamp)}`}
                              >
                                <Icon name="trash" className="h-4 w-4" />
                              </button>
                            </div>
                          </td>
                        )}
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
          {!loading && eventRows.length === 0 && <EmptyState icon="scan" title="No scans in this range" message="Try a wider date range." />}
          <Pager offset={offset} pageSize={PAGE_SIZE} shown={events.length} total={total} noun="scans" disabled={loading} onChange={(o) => setPage({ key: filterKey, offset: o })} />
        </div>
      )}

      {manualOpen && (
        <ManualEntry
          onClose={() => setManualOpen(false)}
          onSaved={() => {
            setManualOpen(false);
            load();
          }}
        />
      )}

      {editing && (
        <CorrectEntry
          event={editing}
          onClose={() => setEditing(null)}
          onSaved={(updated) => {
            setEditing(null);
            setEvents((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
          }}
        />
      )}

      <ConfirmDialog
        open={!!deleting}
        title="Delete attendance record?"
        danger
        busy={busy}
        confirmLabel="Delete"
        message={
          <>
            Remove the {deleting ? eventLabel(deleting) : ""} for <b className="text-white">{deleting?.user_name}</b> at {formatTime(deleting?.timestamp)}? This is recorded in the audit log.
          </>
        }
        onConfirm={() => deleting && deleteEvent(deleting)}
        onClose={() => !busy && setDeleting(null)}
      />
    </>
  );
}

/** A time, with the calendar date added when it falls on a different day than the work day (night shifts). */
function TimeWithDay({ iso, workDate }: { iso: string | null; workDate: string }) {
  if (!iso) return <>—</>;
  const day = toDatetimeLocal(iso).slice(0, 10);
  return (
    <>
      {formatTime(iso)}
      {day !== workDate && <span className="ml-1 text-[11px] text-sky-300">({formatDate(day, { month: "short", day: "numeric" })})</span>}
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
  const [employee, setEmployee] = useState<PickedEmployee | null>(null);
  // `datetime-local` holds org-local wall time; it is sent as-is (naive) and the server applies the org timezone.
  const [form, setForm] = useState(() => ({ event_type: "CLOCK_IN", session: "", timestamp: toDatetimeLocal(), notes: "" }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (saving) return;
    if (!employee || !form.notes.trim() || !form.timestamp) {
      setError("Choose an employee, a date and time, and give a reason.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.post("/attendance", {
        user_id: employee.id,
        event_type: form.event_type,
        session: form.session || undefined,
        timestamp: datetimeLocalToApi(form.timestamp),
        notes: form.notes.trim(),
      });
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
          <button className="btn-ghost" onClick={onClose} disabled={saving}>
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
        <EmployeePicker value={employee} onChange={setEmployee} autoFocus />
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
        <Field label="Date & time" hint="Organisation time. Future times aren't accepted.">
          <input type="datetime-local" className="input" value={form.timestamp} max={toDatetimeLocal()} onChange={(e) => setForm({ ...form, timestamp: e.target.value })} />
        </Field>
        <Field label="Reason">
          <input className="input" value={form.notes} maxLength={255} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="e.g. Kiosk camera offline" />
        </Field>
        {error && (
          <p role="alert" className="text-sm text-red-300">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}

/** Correct an existing punch: type, session, time and note. Only changed fields are sent. */
function CorrectEntry({ event, onClose, onSaved }: { event: EventRow; onClose: () => void; onSaved: (e: EventRow) => void }) {
  const initial = useMemo(
    () => ({ event_type: event.event_type, session: event.session, timestamp: toDatetimeLocal(event.timestamp), notes: event.notes ?? "" }),
    [event]
  );
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (saving) return;
    const changes: Record<string, string | null> = {};
    if (form.event_type !== initial.event_type) changes.event_type = form.event_type;
    if (form.session !== initial.session) changes.session = form.session;
    if (form.timestamp !== initial.timestamp) {
      if (!form.timestamp) {
        setError("Enter a date and time.");
        return;
      }
      changes.timestamp = datetimeLocalToApi(form.timestamp);
    }
    if (form.notes !== initial.notes) changes.notes = form.notes.trim() || null;
    if (Object.keys(changes).length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await api.patch<EventRow>(`/attendance/${event.id}`, changes);
      toast.success("Record corrected", "The before/after values were written to the audit log.");
      onSaved(res.data);
    } catch (err) {
      setError(errorMessage(err, "Couldn't save the correction."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Correct attendance record"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn-primary" onClick={save} disabled={saving}>
            {saving && <Spinner />} Save correction
          </button>
        </>
      }
    >
      <p className="mb-4 text-sm text-neutral-400">
        <b className="text-white">{event.user_name}</b> · {formatDate(event.timestamp, SHORT_DATE)} {formatTime(event.timestamp)}
      </p>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Event">
            <select className="input" value={form.event_type} onChange={(e) => setForm({ ...form, event_type: e.target.value as EventRow["event_type"] })}>
              <option value="CLOCK_IN">Clock in</option>
              <option value="CLOCK_OUT">Clock out</option>
            </select>
          </Field>
          <Field label="Session">
            <select className="input" value={form.session} onChange={(e) => setForm({ ...form, session: e.target.value as EventRow["session"] })}>
              <option value="AM">AM</option>
              <option value="PM">PM</option>
              <option value="OT">OT</option>
            </select>
          </Field>
        </div>
        <Field label="Date & time" hint="Organisation time.">
          <input type="datetime-local" className="input" value={form.timestamp} max={toDatetimeLocal()} onChange={(e) => setForm({ ...form, timestamp: e.target.value })} />
        </Field>
        <Field label="Note">
          <input className="input" value={form.notes} maxLength={255} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Why this record was corrected" />
        </Field>
        {error && (
          <p role="alert" className="text-sm text-red-300">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
