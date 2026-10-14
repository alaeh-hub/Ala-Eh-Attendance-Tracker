import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import Pager from "../../components/admin/Pager";
import Tabs, { tabPanelProps } from "../../components/admin/Tabs";
import { cleanParams, isCancelled, totalCount, useLatestRequest } from "../../components/admin/request";
import Icon from "../../components/Icon";
import { EmptyState, PageHeader, Spinner, StatCard } from "../../components/ui";
import api, { downloadFile, errorMessage } from "../../services/api";
import { toast } from "../../stores/toastStore";
import type { TodayReport } from "../../types";
import { formatDate, formatTimeWithSeconds, orgDate, orgMonthStart } from "../../utils/orgTime";
import { smartMatch } from "../../utils/search";

interface HoursEmployee {
  user_id: string;
  user_name: string;
  employee_code: string | null;
  department: string | null;
  days_worked: number;
  hours: number;
  ot_hours: number;
  total_hours: number;
  late_days: number;
}

interface HoursSummary {
  employees: HoursEmployee[];
  totals: { employees: number; hours: number; ot_hours: number; total_hours: number };
}

interface AuditEntry {
  id: string;
  actor_name: string | null;
  action: string;
  target_type: string | null;
  details: string | null;
  created_at: string | null;
}

/** Date presets in the organisation's timezone, not the browser's. */
function preset(kind: "week" | "month" | "last-month"): [string, string] {
  const today = orgDate(0);
  if (kind === "week") {
    const weekday = new Date(`${today}T00:00:00Z`).getUTCDay(); // 0 = Sunday
    return [orgDate(-((weekday + 6) % 7)), today]; // Monday
  }
  const monthStart = orgMonthStart();
  if (kind === "month") return [monthStart, today];
  const lastMonthEnd = new Date(`${monthStart}T00:00:00Z`);
  lastMonthEnd.setUTCDate(0);
  const end = lastMonthEnd.toISOString().slice(0, 10);
  return [`${end.slice(0, 8)}01`, end];
}

const AUDIT_PAGE_SIZE = 50;

/** Audit actions offered as suggestions in the filter (any text is accepted). */
const AUDIT_ACTIONS = [
  "ATTENDANCE_MANUAL_ENTRY",
  "ATTENDANCE_CORRECTED",
  "ATTENDANCE_DELETED",
  "USER_CREATED",
  "USER_UPDATED",
  "USER_DELETED",
  "USER_ARCHIVED",
  "USER_ROLE_CHANGED",
  "FACE_SAMPLE_ENROLLED",
  "FACE_DATA_RESET",
  "SNAPSHOT_ENROLLED",
  "SNAPSHOT_DISMISSED",
  "KIOSK_LOCKED",
  "KIOSK_UNLOCKED",
  "KIOSK_UNLOCK_FAILED",
  "ALL_DATA_CLEARED",
];

function auditWhen(iso: string | null) {
  if (!iso) return "—";
  return `${formatDate(iso, { month: "short", day: "numeric", year: "numeric" })}, ${formatTimeWithSeconds(iso)}`;
}

const PRESETS = [
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
  { key: "last-month", label: "Last month" },
] as const;

function hoursLabel(h: number) {
  let hh = Math.floor(h);
  let mm = Math.round((h - hh) * 60);
  if (mm === 60) {
    hh += 1;
    mm = 0;
  }
  return `${hh}h ${String(mm).padStart(2, "0")}m`;
}

export default function Reports() {
  const [tab, setTab] = useState<"hours" | "audit">("hours");
  const [today, setToday] = useState<TodayReport | null>(null);
  const [[from, to], setRange] = useState<[string, string]>(preset("month"));
  const [department, setDepartment] = useState("");
  const [departments, setDepartments] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [summary, setSummary] = useState<HoursSummary | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditFilter, setAuditFilter] = useState({ from: "", to: "", action: "" });
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState<string | null>(null);
  const begin = useLatestRequest();

  useEffect(() => {
    api.get<TodayReport>("/reports/today").then((r) => setToday(r.data)).catch(() => undefined);
    api.get<string[]>("/users/departments").then((r) => setDepartments(r.data)).catch(() => undefined);
  }, []);

  const params = useMemo(() => cleanParams({ from, to, department }), [from, to, department]);
  // The action box is free text: wait until typing pauses before querying.
  const [auditAction, setAuditAction] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setAuditAction(auditFilter.action.trim()), 300);
    return () => clearTimeout(t);
  }, [auditFilter.action]);
  const auditParams = useMemo(() => cleanParams({ from: auditFilter.from, to: auditFilter.to, action: auditAction }), [auditFilter.from, auditFilter.to, auditAction]);

  // A page offset belongs to one audit filter; changing the filter goes back to the first page.
  const auditKey = JSON.stringify(auditParams);
  const [auditPage, setAuditPage] = useState({ key: auditKey, offset: 0 });
  const auditOffset = auditPage.key === auditKey ? auditPage.offset : 0;

  const load = useCallback(async () => {
    const req = begin();
    setLoading(true);
    try {
      if (tab === "hours") {
        const res = await api.get<HoursSummary>("/reports/hours-summary", { params, signal: req.signal });
        if (!req.isCurrent()) return;
        setSummary(res.data);
      } else {
        const res = await api.get<AuditEntry[]>("/reports/audit", {
          params: { ...auditParams, limit: AUDIT_PAGE_SIZE, offset: auditOffset },
          signal: req.signal,
        });
        if (!req.isCurrent()) return;
        setAudit(res.data);
        setAuditTotal(totalCount(res.headers, auditOffset + res.data.length));
      }
    } catch (err) {
      if (!req.isCurrent() || isCancelled(err)) return;
      toast.error("Couldn't load data", errorMessage(err));
    } finally {
      if (req.isCurrent()) setLoading(false);
    }
  }, [tab, params, auditParams, auditOffset, begin]);

  useEffect(() => {
    load();
  }, [load]);

  const rows = (summary?.employees ?? []).filter((e) => smartMatch(search, [e.user_name, e.employee_code, e.department]));
  // Totals follow the search box so what's on screen matches the numbers shown.
  const totals = useMemo(
    () => ({
      employees: rows.length,
      hours: rows.reduce((s, r) => s + r.hours, 0),
      ot: rows.reduce((s, r) => s + r.ot_hours, 0),
      total: rows.reduce((s, r) => s + r.total_hours, 0),
    }),
    [rows]
  );

  async function exportPdf(userId?: string) {
    setExporting(userId ?? "all");
    try {
      await downloadFile("/reports/hours.pdf", { ...params, user_id: userId }, `hours_${from}_${to}.pdf`);
      toast.success("PDF ready", userId ? "Employee hours report downloaded." : "Hours for all employees downloaded.");
    } catch (err) {
      toast.error("Export failed", errorMessage(err));
    } finally {
      setExporting(null);
    }
  }

  const activePreset = PRESETS.find((p) => {
    const [a, b] = preset(p.key);
    return a === from && b === to;
  })?.key;

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle="Hours worked per employee, PDF export and the audit trail."
        actions={
          <>
            <Link to="/admin/employees" className="btn-ghost">
              <Icon name="users" className="h-4 w-4" /> Manage employees
            </Link>
            {tab === "hours" && (
              <button className="btn-primary" onClick={() => exportPdf()} disabled={exporting !== null || rows.length === 0}>
                {exporting === "all" ? <Spinner /> : <Icon name="download" className="h-4 w-4" />} Export PDF
              </button>
            )}
          </>
        }
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Employees" value={today?.total_employees ?? 0} loading={!today} accent />
        <StatCard label="Present today" value={today?.present ?? 0} loading={!today} delay={60} />
        <StatCard label="Late today" value={today?.late ?? 0} loading={!today} delay={120} />
        <StatCard label="Scans today" value={today?.events_today ?? 0} loading={!today} delay={180} />
      </div>

      <Tabs
        label="Report"
        idPrefix="reports"
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "hours", label: "Employee hours" },
          { key: "audit", label: "Audit log" },
        ]}
      />

      {tab === "hours" ? (
        <div {...tabPanelProps("reports", "hours")}>
          <div className="card mb-4 space-y-3 p-3 animate-fade-up">
            <div className="flex flex-wrap items-center gap-2">
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
                <input type="date" className="input w-auto py-1.5" value={from} max={to} onChange={(e) => e.target.value && setRange([e.target.value, to])} aria-label="From date" />
                <span className="text-neutral-500" aria-hidden="true">→</span>
                <input type="date" className="input w-auto py-1.5" value={to} min={from} onChange={(e) => e.target.value && setRange([from, e.target.value])} aria-label="To date" />
              </div>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative flex-1">
                <Icon name="search" className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
                <input className="input pl-10" placeholder="Filter by employee name or ID…" aria-label="Filter by employee" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
              <select className="input sm:w-52" value={department} onChange={(e) => setDepartment(e.target.value)} aria-label="Department">
                <option value="">All departments</option>
                {departments.map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="mb-4 grid grid-cols-2 gap-3 animate-fade-up sm:grid-cols-4">
            {[
              ["Employees", String(totals.employees)],
              ["Regular hours", hoursLabel(totals.hours)],
              ["OT hours", hoursLabel(totals.ot)],
              ["Total hours", hoursLabel(totals.total)],
            ].map(([k, v]) => (
              <div key={k} className="card border border-brand-500/30 px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">{k}</p>
                <p className="mt-0.5 text-xl font-extrabold tabular-nums text-white">{loading ? "—" : v}</p>
              </div>
            ))}
          </div>

          <div className="card overflow-hidden animate-fade-up">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="border-b border-white/[0.06] bg-white/[0.02]">
                  <tr>
                    <th className="table-head">Employee</th>
                    <th className="table-head">Days</th>
                    <th className="table-head">Regular</th>
                    <th className="table-head">OT</th>
                    <th className="table-head">Total</th>
                    <th className="table-head">Late days</th>
                    <th className="table-head">
                      <span className="sr-only">Download</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04]">
                  {loading &&
                    Array.from({ length: 5 }).map((_, i) => (
                      <tr key={i}>
                        {Array.from({ length: 7 }).map((__, j) => (
                          <td key={j} className="table-cell">
                            <div className="skeleton h-4 w-full max-w-[100px]" />
                          </td>
                        ))}
                      </tr>
                    ))}
                  {!loading &&
                    rows.map((r) => (
                      <tr key={r.user_id} className="hover:bg-white/[0.02]">
                        <td className="table-cell">
                          <p className="font-semibold text-white">{r.user_name}</p>
                          <p className="text-xs text-neutral-500">{[r.employee_code, r.department].filter(Boolean).join(" · ")}</p>
                        </td>
                        <td className="table-cell tabular-nums text-neutral-300">{r.days_worked}</td>
                        <td className="table-cell tabular-nums text-neutral-200">{hoursLabel(r.hours)}</td>
                        <td className="table-cell tabular-nums text-neutral-300">{r.ot_hours ? hoursLabel(r.ot_hours) : "—"}</td>
                        <td className="table-cell font-semibold tabular-nums text-white">{hoursLabel(r.total_hours)}</td>
                        <td className="table-cell tabular-nums text-neutral-300">{r.late_days || "—"}</td>
                        <td className="table-cell text-right">
                          <button
                            onClick={() => exportPdf(r.user_id)}
                            disabled={exporting !== null}
                            className="rounded-lg p-2 text-neutral-500 hover:bg-white/[0.06] hover:text-white"
                            title={`Download PDF for ${r.user_name}`}
                            aria-label={`Download hours PDF for ${r.user_name}`}
                          >
                            {exporting === r.user_id ? <Spinner /> : <Icon name="download" className="h-4 w-4" />}
                          </button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
            {!loading && rows.length === 0 && <EmptyState icon="records" title="No hours in this range" message="Pick a different date range or department." />}
          </div>
        </div>
      ) : (
        <div {...tabPanelProps("reports", "audit")}>
          <div className="card mb-4 flex flex-wrap items-end gap-2 p-3 animate-fade-up">
            <label className="block">
              <span className="label">From</span>
              <input type="date" className="input w-auto py-1.5" value={auditFilter.from} max={auditFilter.to || undefined} onChange={(e) => setAuditFilter((f) => ({ ...f, from: e.target.value }))} />
            </label>
            <label className="block">
              <span className="label">To</span>
              <input type="date" className="input w-auto py-1.5" value={auditFilter.to} min={auditFilter.from || undefined} onChange={(e) => setAuditFilter((f) => ({ ...f, to: e.target.value }))} />
            </label>
            <label className="block min-w-[220px] flex-1">
              <span className="label">Action</span>
              <input
                className="input py-1.5 font-mono text-xs"
                list="audit-actions"
                value={auditFilter.action}
                onChange={(e) => setAuditFilter((f) => ({ ...f, action: e.target.value.toUpperCase() }))}
                placeholder="Any action"
              />
              <datalist id="audit-actions">
                {AUDIT_ACTIONS.map((a) => (
                  <option key={a} value={a} />
                ))}
              </datalist>
            </label>
            {(auditFilter.from || auditFilter.to || auditFilter.action) && (
              <button type="button" className="btn-ghost py-1.5 text-xs" onClick={() => setAuditFilter({ from: "", to: "", action: "" })}>
                Clear filters
              </button>
            )}
          </div>
          <div className="card overflow-hidden animate-fade-up">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b border-white/[0.06] bg-white/[0.02]">
                <tr>
                  <th className="table-head">When</th>
                  <th className="table-head">Who</th>
                  <th className="table-head">Action</th>
                  <th className="table-head">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.04]">
                {!loading &&
                  audit.map((a) => (
                    <tr key={a.id} className="hover:bg-white/[0.02]">
                      <td className="table-cell whitespace-nowrap tabular-nums text-neutral-400">{auditWhen(a.created_at)}</td>
                      <td className="table-cell text-white">{a.actor_name ?? "System"}</td>
                      <td className="table-cell font-mono text-xs text-neutral-300">{a.action}</td>
                      <td className="table-cell max-w-[320px] truncate text-xs text-neutral-500" title={a.details ?? ""}>{a.details ?? ""}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          {loading && <div className="flex justify-center py-10 text-brand-400"><Spinner className="h-6 w-6" /></div>}
          {!loading && audit.length === 0 && <EmptyState icon="shield" title={auditKey === "{}" ? "No audit entries yet" : "No audit entries match these filters"} />}
          <Pager offset={auditOffset} pageSize={AUDIT_PAGE_SIZE} shown={audit.length} total={auditTotal} noun="entries" disabled={loading} onChange={(o) => setAuditPage({ key: auditKey, offset: o })} />
          </div>
        </div>
      )}
    </>
  );
}
