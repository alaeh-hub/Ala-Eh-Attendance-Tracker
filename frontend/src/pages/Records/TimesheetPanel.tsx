import Highlight from "../../components/Highlight";
import { EmptyState, formatMinutes } from "../../components/ui";
import { tabPanelProps } from "../../components/admin/Tabs";
import type { DayRow } from "./recordsUtils";
import { hoursLabel } from "../../utils/hours";
import { ROWS_PER_PAGE, SHORT_DATE, missedTimeOut } from "./recordsUtils";
import { SkeletonRows, TimeWithDay } from "./TableParts";
import { formatDate } from "../../utils/orgTime";

type Totals = { people: number; hours: number; otHours: number; late: number };

/** The per-work-day timesheet: totals on top, one row per employee and day. */
export default function TimesheetPanel({ rows, loading, query, totals, shown, onShowMore }: {
  rows: DayRow[];
  loading: boolean;
  query: string;
  totals: Totals;
  shown: number;
  onShowMore: () => void;
}) {
  return (
    <div {...tabPanelProps("records", "timesheet")}>
      <div className="mb-4 grid grid-cols-2 gap-3 animate-fade-up sm:grid-cols-4">
        {[
          ["Employees", String(totals.people)],
          ["Hours worked", hoursLabel(totals.hours)],
          ["OT hours", hoursLabel(totals.otHours)],
          ["Late arrivals", String(totals.late)],
        ].map(([k, v]) => (
          <div key={k} className="stat">
            <p className="text-[11px] font-semibold text-neutral-500">{k}</p>
            <p className="mt-0.5 text-xl font-extrabold tabular-nums text-white">{loading ? "—" : v}</p>
          </div>
        ))}
      </div>
      <div className="panel overflow-hidden animate-fade-up">
        <div className="overflow-x-auto">
          <table className="rtable w-full min-w-[860px] table-fixed text-sm">
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
                rows.slice(0, shown).map((r) => (
                  <tr key={`${r.user_id}-${r.date}`} className="hover:bg-white/[0.02]">
                    <td data-label="Work day" className="table-cell cell-full whitespace-nowrap text-neutral-400">{formatDate(r.date, SHORT_DATE)}</td>
                    <td className="table-cell cell-primary">
                      <p className="font-semibold text-white"><Highlight text={r.user_name} query={query} /></p>
                      <p className="text-xs text-neutral-500">{[r.employee_code, r.department].filter(Boolean).join(" · ")}</p>
                    </td>
                    <td data-label="Time in" className="table-cell tabular-nums text-neutral-200">
                      <TimeWithDay iso={r.first_in} workDate={r.date} />
                    </td>
                    <td data-label="Time out" className="table-cell tabular-nums text-neutral-200">
                      {r.last_out ? <TimeWithDay iso={r.last_out} workDate={r.date} /> : r.open && !missedTimeOut(r) ? <span className="tag tag-ok">On site</span> : "—"}
                    </td>
                    <td data-label="Hours" className="table-cell font-semibold tabular-nums text-white">{hoursLabel(r.hours)}</td>
                    <td data-label="OT" className="table-cell tabular-nums text-neutral-300">{r.ot_hours ? hoursLabel(r.ot_hours) : "—"}</td>
                    <td data-label="Status" className="table-cell cell-full">
                      <div className="flex flex-col gap-0.5 max-lg:flex-row max-lg:flex-wrap max-lg:gap-x-3">
                        {r.late ? (
                          <span className="tag tag-warn">Late{r.late_minutes ? ` ${formatMinutes(r.late_minutes)}` : ""}</span>
                        ) : r.first_in ? (
                          <span className="tag tag-ok">On time</span>
                        ) : (
                          <span className="tag tag-muted">No clock-in</span>
                        )}
                        {missedTimeOut(r) && <span className="tag tag-warn">No time out</span>}
                        {r.early_leave && (
                          <span className="tag tag-info">Left early{r.early_minutes ? ` ${formatMinutes(r.early_minutes)}` : ""}</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {!loading && rows.length > shown && (
          <div className="flex items-center justify-between border-t border-white/[0.06] px-4 py-3 text-sm text-neutral-400">
            <span>
              Showing {shown} of {rows.length} days
            </span>
            <button className="btn-ghost" onClick={onShowMore}>
              Show {Math.min(ROWS_PER_PAGE, rows.length - shown)} more
            </button>
          </div>
        )}
        {!loading && rows.length === 0 && <EmptyState icon="records" title="No attendance in this range" message="Pick a different date range or department." />}
      </div>
    </div>
  );
}
