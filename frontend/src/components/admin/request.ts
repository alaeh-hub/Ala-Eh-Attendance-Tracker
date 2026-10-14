import { useCallback, useEffect, useRef } from "react";

/**
 * Guards against stale responses: every call to the returned `begin()` aborts
 * the previous in-flight request and hands out a ticket whose `isCurrent()`
 * turns false as soon as a newer request starts (or the component unmounts).
 * A slow response for an old filter/tab can therefore never overwrite the
 * results of the newer one.
 */
export function useLatestRequest() {
  const state = useRef<{ id: number; ctrl: AbortController | null }>({ id: 0, ctrl: null });

  useEffect(() => {
    const s = state.current;
    return () => {
      s.id += 1;
      s.ctrl?.abort();
    };
  }, []);

  return useCallback(() => {
    const s = state.current;
    s.ctrl?.abort();
    const ctrl = new AbortController();
    const id = ++s.id;
    s.ctrl = ctrl;
    return { signal: ctrl.signal, isCurrent: () => s.id === id };
  }, []);
}

/** True for an aborted/cancelled axios request (not a real failure). */
export function isCancelled(err: unknown): boolean {
  const e = err as { code?: string; name?: string } | null;
  return e?.code === "ERR_CANCELED" || e?.name === "CanceledError" || e?.name === "AbortError";
}

/** Reads the `X-Total-Count` header of a paged list response. */
export function totalCount(headers: unknown, fallback: number): number {
  const h = headers as Record<string, unknown> | { get?: (k: string) => unknown } | undefined;
  if (!h) return fallback;
  const raw = typeof (h as { get?: unknown }).get === "function" ? (h as { get: (k: string) => unknown }).get("x-total-count") : (h as Record<string, unknown>)["x-total-count"] ?? (h as Record<string, unknown>)["X-Total-Count"];
  const n = Number(raw);
  return raw !== undefined && raw !== null && raw !== "" && Number.isFinite(n) ? n : fallback;
}

/** Drops empty-string / null / undefined values so the API never sees `from=""`. */
export function cleanParams<T extends Record<string, unknown>>(params: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v !== "" && v !== null && v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

/** Seconds to wait from a 429 response (`retry_after` body field or `Retry-After` header). */
export function retryAfterSeconds(err: unknown, fallback = 5): number | null {
  const res = (err as { response?: { status?: number; data?: { retry_after?: unknown }; headers?: Record<string, unknown> } })?.response;
  if (res?.status !== 429) return null;
  const n = Number(res.data?.retry_after ?? res.headers?.["retry-after"]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
