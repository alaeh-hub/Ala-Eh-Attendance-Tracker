import { matchRanges } from "../utils/search";

/** Renders `text` with the parts that matched `query` picked out. Plain text when there is no query. */
export default function Highlight({ text, query }: { text: string | null | undefined; query: string }) {
  if (!text) return <>{text ?? ""}</>;
  const ranges = query.trim() ? matchRanges(text, query) : [];
  if (!ranges.length) return <>{text}</>;
  const out: React.ReactNode[] = [];
  let at = 0;
  ranges.forEach(([s, e], i) => {
    if (s > at) out.push(text.slice(at, s));
    out.push(
      <mark key={i} className="rounded-sm bg-brand-500/25 px-px text-inherit underline decoration-brand-400/70 decoration-1 underline-offset-2">
        {text.slice(s, e)}
      </mark>
    );
    at = e;
  });
  if (at < text.length) out.push(text.slice(at));
  return <>{out}</>;
}
