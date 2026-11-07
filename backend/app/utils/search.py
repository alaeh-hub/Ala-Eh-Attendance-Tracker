"""Smart search, the server half. The same algorithm as frontend/src/utils/search.ts, so a search that finds someone on
screen finds them in the employee picker, the enrollment list and the PDF export too.

* Every word of the query must match somewhere across the fields, in any order and in any field.
* Case, accents and punctuation don't matter ("jose" finds "José", "emp 7" finds "EMP-0007").
* A word matches whole, as a word start, inside a word, or across a space in a name ("delacruz" finds "Dela Cruz").
* Typos are forgiven for words of 4+ letters: one up to 7 letters, two from 8. Anything with a digit must match exactly.
* Typo matches are only a fallback: they show when nothing matches literally.

Keep the two implementations in step; both have tests that pin the same cases.
"""
from __future__ import annotations

import unicodedata
from typing import Callable, Iterable, Sequence, TypeVar

T = TypeVar("T")

# Literal matches score 40+ before field weighting (28+ after it); typo matches top out at 19.
STRICT = 26


def fold(text: str) -> str:
    """Lower-case, strip accents, turn everything that is not a letter or digit into a space. Same length as the input."""
    out = []
    for ch in text:
        base = "".join(c for c in unicodedata.normalize("NFD", ch) if unicodedata.category(c) != "Mn").lower()
        f = base[:1] or " "
        out.append(f if f.isalnum() else " ")
    return "".join(out)


def _words(folded: str) -> list[str]:
    return [w for w in folded.split(" ") if w]


def _distance(a: str, b: str, limit: int) -> int:
    """Optimal-string-alignment distance (insert, delete, substitute, swap neighbours); limit + 1 means 'too far'."""
    if abs(len(a) - len(b)) > limit:
        return limit + 1
    prev2: list[int] = []
    prev = list(range(len(b) + 1))
    for i in range(1, len(a) + 1):
        row = [i] + [0] * len(b)
        row_min = i
        for j in range(1, len(b) + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            v = min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost)
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                v = min(v, prev2[j - 2] + 1)
            row[j] = v
            row_min = min(row_min, v)
        if row_min > limit:
            return limit + 1
        prev2, prev = prev, row
    return prev[len(b)]


def _typos(token: str) -> int:
    if any(c.isdigit() for c in token):
        return 0
    return 2 if len(token) >= 8 else 1 if len(token) >= 4 else 0


def _token_score(token: str, words: list[str], compact: str) -> int:
    best = 0
    for w in words:
        if w == token:
            return 100
        if w.startswith(token):
            best = max(best, 80 - min(10, len(w) - len(token)))
        elif len(token) >= 2 and token in w:
            best = max(best, 50)
    if best:
        return best
    if len(token) >= 3 and token in compact:
        return 40
    limit = _typos(token)
    if not limit:
        return 0
    for w in words:
        d = _distance(token, w, limit)
        if d <= limit:
            best = max(best, 25 - 6 * d)
        elif len(w) > len(token):
            p = _distance(token, w[: len(token)], limit)
            if p <= limit:
                best = max(best, 18 - 5 * p)
    return best


def score(query: str, fields: Iterable[str | None]) -> tuple[float, bool]:
    """(score, strict). Score 0 means no match. Earlier fields count a little more, so put the name first."""
    tokens = _words(fold(query or ""))
    if not tokens:
        return 1.0, True
    folded = []
    for f in fields:
        if f:
            s = fold(f)
            folded.append((_words(s), s.replace(" ", "")))
    total = 0.0
    strict = True
    for token in tokens:
        best = 0.0
        for i, (words, compact) in enumerate(folded):
            best = max(best, _token_score(token, words, compact) * max(0.7, 1 - 0.08 * i))
        if best == 0:
            return 0.0, False
        if best < STRICT:
            strict = False
        total += best
    return total, strict


def smart_filter(items: Sequence[T], query: str, fields: Callable[[T], Iterable[str | None]], rank: bool = True) -> list[T]:
    """The items matching `query`, best first (or in their original order with rank=False)."""
    if not (query or "").strip():
        return list(items)
    scored = []
    for at, item in enumerate(items):
        s, strict = score(query, fields(item))
        if s > 0:
            scored.append((item, s, at, strict))
    if any(x[3] for x in scored):
        scored = [x for x in scored if x[3]]
    if rank:
        scored.sort(key=lambda x: (-x[1], x[2]))
    return [x[0] for x in scored]
