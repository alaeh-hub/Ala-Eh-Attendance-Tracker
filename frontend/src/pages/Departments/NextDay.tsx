import { isOvernight } from "./scheduleRules";

/** A "+1 day" badge on a schedule that ends the next calendar day. */
export default function NextDay({ start, end }: { start: string | null | undefined; end: string | null | undefined }) {
  if (!isOvernight(start, end)) return null;
  return (
    <span className="ml-1 rounded bg-indigo-500/15 px-1 py-px text-[10px] font-semibold text-indigo-200" title="Ends the next day">
      +1 day
    </span>
  );
}
