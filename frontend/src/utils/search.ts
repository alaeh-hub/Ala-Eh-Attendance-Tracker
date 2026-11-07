/**
 * Smart search. One engine behind every search box in the app.
 *
 *  - Every word of the query must match somewhere across the given fields, in any order and in any field
 *    ("juan hr" finds Juan Dela Cruz in HR).
 *  - Case, accents and punctuation don't matter ("jose" finds "José", "emp 7" finds "EMP-0007").
 *  - A word matches as a whole word, as the start of a word, inside a word, or across a space in a name
 *    ("delacruz" finds "Dela Cruz").
 *  - Typos are forgiven for words of 4+ letters: one slip up to 7 letters, two from 8 ("jaun" finds "Juan").
 *    Anything containing a digit must match exactly, so employee code 0007 never matches 0008.
 *  - Results can be ranked best-first: whole word, then word start, then inside a word, then a near miss.
 *
 * backend/app/utils/search.py is the same algorithm, so the server and the screen agree on what matches.
 */

const MARKS = /[̀-ͯ]/g;
const WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Lower-cases, strips accents and turns every non-letter/digit into a space. Always the same length as the input,
 * so a position in the folded text is a position in the original (that is what lets matches be highlighted).
 */
export function fold(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const f = (text[i].normalize("NFD").replace(MARKS, "").toLowerCase() || " ")[0];
    out += WORD_CHAR.test(f) ? f : " ";
  }
  return out;
}

const wordsOf = (folded: string) => folded.split(" ").filter(Boolean);

/** Optimal-string-alignment distance (insert, delete, substitute, swap two neighbours), giving up above `max`. */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      row[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = row;
  }
  return prev[b.length];
}

const allowedTypos = (token: string) => (/\d/.test(token) ? 0 : token.length >= 8 ? 2 : token.length >= 4 ? 1 : 0);

interface Folded {
  words: string[];
  compact: string;
}

/** How well one query word matches one field. 0 means not at all. */
function tokenScore(token: string, field: Folded): number {
  let best = 0;
  for (const w of field.words) {
    if (w === token) return 100;
    if (w.startsWith(token)) best = Math.max(best, 80 - Math.min(10, w.length - token.length));
    else if (token.length >= 2 && w.includes(token)) best = Math.max(best, 50);
  }
  if (best) return best;
  if (token.length >= 3 && field.compact.includes(token)) return 40;
  const max = allowedTypos(token);
  if (!max) return 0;
  for (const w of field.words) {
    const d = distance(token, w, max);
    if (d <= max) best = Math.max(best, 25 - 6 * d);
    else if (w.length > token.length) {
      // A typo in a word that is still being typed: compare against the same number of leading letters.
      const p = distance(token, w.slice(0, token.length), max);
      if (p <= max) best = Math.max(best, 18 - 5 * p);
    }
  }
  return best;
}

type Fields = readonly (string | null | undefined)[];

/**
 * Literal matches score 40+ before the field weighting (so 28+ after it, weights bottom out at 0.7); typo matches top out
 * at 19. A token that reaches this line was matched literally.
 */
const STRICT = 26;

/** 0 = no match. Earlier fields count a little more (put the name first). An empty query scores 1 for everything. */
export function smartScore(query: string, fields: Fields): number {
  return detail(query, fields).score;
}

function detail(query: string, fields: Fields): { score: number; strict: boolean } {
  const tokens = wordsOf(fold(query));
  if (!tokens.length) return { score: 1, strict: true };
  const folded: Folded[] = fields.filter(Boolean).map((f) => {
    const s = fold(f as string);
    return { words: wordsOf(s), compact: s.replace(/ /g, "") };
  });
  let total = 0;
  let strict = true;
  for (const token of tokens) {
    let best = 0;
    folded.forEach((f, i) => {
      best = Math.max(best, tokenScore(token, f) * Math.max(0.7, 1 - 0.08 * i));
    });
    if (best === 0) return { score: 0, strict: false };
    if (best < STRICT) strict = false;
    total += best;
  }
  return { score: total, strict };
}

export function smartMatch(query: string, fields: Fields): boolean {
  return smartScore(query, fields) > 0;
}

/**
 * Keeps the items that match. With `rank`, best matches first (ties keep their original order).
 * Typo matches are a fallback: they only show when nothing matches literally ("mario" will not also list "Maria").
 */
export function smartFilter<T>(items: readonly T[], query: string, fields: (item: T) => Fields, { rank = false }: { rank?: boolean } = {}): T[] {
  if (!query.trim()) return items as T[];
  let scored: { item: T; score: number; at: number; strict: boolean }[] = [];
  items.forEach((item, at) => {
    const d = detail(query, fields(item));
    if (d.score > 0) scored.push({ item, score: d.score, at, strict: d.strict });
  });
  if (scored.some((s) => s.strict)) scored = scored.filter((s) => s.strict);
  if (rank) scored.sort((a, b) => b.score - a.score || a.at - b.at);
  return scored.map((s) => s.item);
}

/** Orders items best match first without dropping any (for lists the server already filtered). */
export function smartRank<T>(items: readonly T[], query: string, fields: (item: T) => Fields): T[] {
  if (!query.trim()) return items as T[];
  return items
    .map((item, at) => ({ item, at, score: smartScore(query, fields(item)) }))
    .sort((a, b) => b.score - a.score || a.at - b.at)
    .map((s) => s.item);
}

/** [start, end) ranges of `text` to highlight for `query`, merged and in order. */
export function matchRanges(text: string, query: string): [number, number][] {
  const tokens = wordsOf(fold(query));
  if (!text || !tokens.length) return [];
  const folded = fold(text);
  const ranges: [number, number][] = [];
  for (const token of tokens) {
    let found = false;
    for (let at = folded.indexOf(token); at !== -1; at = folded.indexOf(token, at + token.length)) {
      ranges.push([at, at + token.length]);
      found = true;
    }
    if (found) continue;
    const max = allowedTypos(token);
    if (!max) continue;
    // No literal hit: highlight the word that was probably meant.
    let pos = 0;
    for (const w of folded.split(" ")) {
      if (w && (distance(token, w, max) <= max || (w.length > token.length && distance(token, w.slice(0, token.length), max) <= max))) ranges.push([pos, pos + w.length]);
      pos += w.length + 1;
    }
  }
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}
