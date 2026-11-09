import { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import EmployeePicker, { PickedEmployee } from "../../components/admin/EmployeePicker";
import Tabs from "../../components/admin/Tabs";
import { cleanParams, isCancelled, totalCount, useLatestRequest } from "../../components/admin/request";
import { DateField, Select } from "../../components/fields";
import Icon from "../../components/Icon";
import SearchInput from "../../components/SearchInput";
import { ConfirmDialog, PageHeader, Spinner } from "../../components/ui";
import api, { downloadFile, errorMessage } from "../../services/api";
import { useAuthStore } from "../../stores/authStore";
import { toast } from "../../stores/toastStore";
import { formatTime } from "../../utils/orgTime";
import { smartFilter } from "../../utils/search";
import { CorrectEntry, ManualEntry } from "./EntryDialogs";
import { type DayRow, type EventRow, PAGE_SIZE, PRESETS, ROWS_PER_PAGE, eventLabel, preset } from "./recordsUtils";
import ScanLogPanel from "./ScanLogPanel";
import TimesheetPanel from "./TimesheetPanel";

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

  const q = useDeferredValue(search);
  const dailyRows = smartFilter(daily, q, (r) => [r.user_name, r.employee_code, r.department]);
  const [shown, setShown] = useState(ROWS_PER_PAGE);
  useEffect(() => setShown(ROWS_PER_PAGE), [daily, search]);
  // Operators can't use the employee picker (it needs the admin-only user list), so their
  // text filter narrows the page that is loaded.
  const pageFilter = !isAdmin && !isStaff;
  const eventRows = pageFilter ? smartFilter(events, q, (e) => [e.user_name, e.employee_code, e.department]) : events;

  const totals = useMemo(
    () => ({
      people: new Set(dailyRows.map((r) => r.user_id)).size,
      hours: dailyRows.reduce((s, r) => s + r.hours, 0),
      otHours: dailyRows.reduce((s, r) => s + (r.ot_hours || 0), 0),
      late: dailyRows.filter((r) => r.late).length,
    }),
    [dailyRows]
  );

  async function exportPdf() {
    setExporting(true);
    try {
      // A summary of the hours worked in the selected dates (and department / search), not the clock-in and out log.
      await downloadFile("/reports/hours-summary.pdf", cleanParams({ from, to, department, q: search.trim() }), `hours-summary_${from}_${to}.pdf`, "Preparing your PDF");
      toast.success("PDF ready", "Hours summary downloaded.");
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
              <button className="btn-primary" onClick={exportPdf} disabled={exporting}>
                {exporting ? <Spinner /> : <Icon name="download" className="h-4 w-4" />} Export PDF
              </button>
            </>
          )
        }
      />

      <div className="bar mb-4 space-y-3 animate-fade-up">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Date range">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              aria-pressed={activePreset === p.key}
              onClick={() => setRange(preset(p.key))}
              className={`rounded-lg px-3 py-2 text-xs font-semibold transition-colors sm:py-1.5 ${activePreset === p.key ? "bg-brand-500 text-black" : "bg-white/[0.04] text-neutral-300 hover:bg-white/[0.08]"}`}
            >
              {p.label}
            </button>
          ))}
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <DateField className="input min-w-0 flex-1 py-1.5 sm:w-auto sm:flex-none" value={from} max={to || undefined} onChange={(e) => setRange([e.target.value, to])} aria-label="From date" />
            <span className="text-neutral-500" aria-hidden="true">→</span>
            <DateField className="input min-w-0 flex-1 py-1.5 sm:w-auto sm:flex-none" value={to} min={from || undefined} onChange={(e) => setRange([from, e.target.value])} aria-label="To date" />
          </div>
        </div>
        {!isStaff && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            {showSearch && (
              <SearchInput
                className="flex-1"
                placeholder={tab === "log" ? "Filter this page by name or ID…" : "Filter by employee name, ID or department…"}
                aria-label="Filter by employee"
                value={search}
                onValueChange={setSearch}
              />
            )}
            {tab === "log" && isAdmin && (
              <div className="flex-1">
                <EmployeePicker label="Employee" value={employee} onChange={setEmployee} status="all" placeholder="All employees — search to filter…" />
              </div>
            )}
            <Select className="input sm:w-52" value={department} onChange={(e) => setDepartment(e.target.value)} aria-label="Department">
              <option value="">All departments</option>
              {departments.map((d) => (
                <option key={d}>{d}</option>
              ))}
            </Select>
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
        <TimesheetPanel rows={dailyRows} loading={loading} query={q} totals={totals} shown={shown} onShowMore={() => setShown((n) => n + ROWS_PER_PAGE)} />
      ) : (
        <ScanLogPanel
          events={eventRows}
          loaded={events.length}
          loading={loading}
          isStaff={isStaff}
          isAdmin={isAdmin}
          query={q}
          offset={offset}
          total={total}
          onEdit={setEditing}
          onDelete={setDeleting}
          onPage={(o) => setPage({ key: filterKey, offset: o })}
        />
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
