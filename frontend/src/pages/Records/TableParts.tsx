import { formatDate, formatTime, toDatetimeLocal } from "../../utils/orgTime";

/** A time, with the calendar date added when it falls on a different day than the work day (night shifts). */
export function TimeWithDay({ iso, workDate }: { iso: string | null; workDate: string }) {
  if (!iso) return <>—</>;
  const day = toDatetimeLocal(iso).slice(0, 10);
  return (
    <>
      {formatTime(iso)}
      {day !== workDate && <span className="ml-1 text-[11px] text-sky-300">({formatDate(day, { month: "short", day: "numeric" })})</span>}
    </>
  );
}

export function SkeletonRows({ cols }: { cols: number }) {
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
