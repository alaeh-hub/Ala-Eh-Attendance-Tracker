import Icon from "../Icon";

/** "Showing X–Y of N" with previous/next buttons for offset-paged tables. */
export default function Pager({
  offset,
  pageSize,
  shown,
  total,
  onChange,
  disabled = false,
  noun = "rows",
}: {
  offset: number;
  pageSize: number;
  /** Rows actually on this page. */
  shown: number;
  total: number;
  onChange: (offset: number) => void;
  disabled?: boolean;
  noun?: string;
}) {
  if (total <= 0) return null;
  const first = Math.min(offset + 1, total);
  const last = Math.min(offset + shown, total);
  const hasPrev = offset > 0;
  const hasNext = offset + pageSize < total;
  return (
    <nav className="flex flex-wrap items-center justify-between gap-2 border-t border-white/[0.06] px-4 py-3 text-xs text-neutral-400" aria-label="Pagination">
      <p aria-live="polite">
        Showing <span className="tabular-nums text-neutral-200">{first}–{last}</span> of <span className="tabular-nums text-neutral-200">{total}</span> {noun}
      </p>
      {(hasPrev || hasNext) && (
        <div className="flex gap-1">
          <button type="button" className="btn-ghost px-3 py-1.5 text-xs" disabled={disabled || !hasPrev} onClick={() => onChange(Math.max(0, offset - pageSize))} aria-label="Previous page">
            <Icon name="arrow_left" className="h-3.5 w-3.5" /> Prev
          </button>
          <button type="button" className="btn-ghost px-3 py-1.5 text-xs" disabled={disabled || !hasNext} onClick={() => onChange(offset + pageSize)} aria-label="Next page">
            Next <Icon name="arrow_right" className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </nav>
  );
}
