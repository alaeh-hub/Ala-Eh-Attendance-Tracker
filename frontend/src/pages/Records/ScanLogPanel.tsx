import Pager from "../../components/admin/Pager";
import { tabPanelProps } from "../../components/admin/Tabs";
import Highlight from "../../components/Highlight";
import Icon from "../../components/Icon";
import { Avatar, EmptyState, EventBadge } from "../../components/ui";
import { formatDate, formatTime, toDatetimeLocal } from "../../utils/orgTime";
import { type EventRow, PAGE_SIZE, SHORT_DATE, eventLabel } from "./recordsUtils";
import { SkeletonRows } from "./TableParts";

/** The raw scan log: one row per punch, with correct / delete for admins. */
export default function ScanLogPanel({ events, loaded, loading, isStaff, isAdmin, query, offset, total, onEdit, onDelete, onPage }: {
  /** The rows to show (a text filter may have narrowed what was loaded). */
  events: EventRow[];
  /** How many rows were loaded for this page, before any text filter. */
  loaded: number;
  loading: boolean;
  isStaff: boolean;
  isAdmin: boolean;
  query: string;
  offset: number;
  total: number;
  onEdit: (e: EventRow) => void;
  onDelete: (e: EventRow) => void;
  onPage: (offset: number) => void;
}) {
  return (
    <div className="panel overflow-hidden animate-fade-up" {...(isStaff ? {} : tabPanelProps("records", "log"))}>
      <div className="overflow-x-auto">
        <table className="rtable w-full min-w-[760px] table-fixed text-sm">
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
              events.map((e) => {
                const calendarDay = toDatetimeLocal(e.timestamp).slice(0, 10);
                const otherWorkDay = e.work_date && e.work_date !== calendarDay ? e.work_date : null;
                return (
                  <tr key={e.id} className="hover:bg-white/[0.02]">
                    <td data-label="When" className="table-cell whitespace-nowrap">
                      <p className="font-semibold tabular-nums text-white">{formatTime(e.timestamp)}</p>
                      <p className="text-xs text-neutral-500">{formatDate(e.timestamp, SHORT_DATE)}</p>
                      {otherWorkDay && (
                        <p className="text-[11px] text-sky-300" title="Night shift: this punch counts toward the shift that started on this day.">
                          Work day {formatDate(otherWorkDay, { month: "short", day: "numeric" })}
                        </p>
                      )}
                    </td>
                    {!isStaff && (
                      <td className="table-cell cell-primary">
                        <div className="flex items-center gap-3">
                          <Avatar userId={e.user_id} name={e.user_name} hasPhoto={e.has_photo} size="h-8 w-8" text="text-[10px]" />
                          <div className="min-w-0">
                            <p className="truncate font-semibold text-white"><Highlight text={e.user_name} query={query} /></p>
                            <p className="truncate text-xs text-neutral-500">{[e.employee_code, e.department].filter(Boolean).join(" · ")}</p>
                          </div>
                        </div>
                      </td>
                    )}
                    <td data-label="Event" className="table-cell cell-full">
                      <EventBadge type={e.event_type} session={e.session} late={e.is_late} lateMinutes={e.late_minutes} earlyMinutes={e.early_minutes} />
                    </td>
                    <td data-label="Method" className="table-cell cell-full cell-wrap text-xs">
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
                    <td data-label="Device" className="table-cell font-mono text-xs text-neutral-500">{e.device_id || "—"}</td>
                    {isAdmin && (
                      <td className="table-cell cell-actions text-right">
                        <div className="flex justify-end gap-1">
                          <button
                            onClick={() => onEdit(e)}
                            className="rounded-lg p-2 text-neutral-500 hover:bg-white/10 hover:text-white"
                            title="Correct record"
                            aria-label={`Correct ${eventLabel(e)} for ${e.user_name ?? "employee"} at ${formatTime(e.timestamp)}`}
                          >
                            <Icon name="edit" className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => onDelete(e)}
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
      {!loading && events.length === 0 && <EmptyState icon="scan" title="No scans in this range" message="Try a wider date range." />}
      <Pager offset={offset} pageSize={PAGE_SIZE} shown={loaded} total={total} noun="scans" disabled={loading} onChange={onPage} />
    </div>
  );
}
