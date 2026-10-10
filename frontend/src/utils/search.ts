/**
 * Token-based search: every whitespace-separated word in the query must
 * appear somewhere across the given fields, in any order and in any field.
 * This is what makes "juan hr" find an employee named "Juan Dela Cruz" in
 * the "HR" department, which a single whole-string `.includes(query)` check
 * (the old behavior) can't do since neither field alone contains "juan hr".
 */
export function smartMatch(query: string, fields: (string | null | undefined)[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = fields.filter(Boolean).join(" \u0000 ").toLowerCase();
  return q.split(/\s+/).every((token) => haystack.includes(token));
}
