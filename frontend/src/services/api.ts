import axios, { AxiosError, InternalAxiosRequestConfig } from "axios";
import type { User } from "../types";
import { EXPIRED_EVENT, KIOSK_LOCKED_EVENT, SESSION_EVENT } from "./authEvents";

/**
 * API base. Production serves the API from the same origin as the app (Caddy
 * routes /api to the backend), and the Vite dev server proxies /api, so the
 * default is the relative "/api". Only set VITE_API_URL for an unusual setup;
 * a cross-origin API cannot use the refresh cookie's CSRF double-submit.
 */
export const API_URL: string = import.meta.env.VITE_API_URL || "/api";

/**
 * Socket.IO server origin: undefined means "the page's own origin" (the
 * normal case). When API_URL is absolute, the socket goes to that origin.
 */
export const SOCKET_URL: string | undefined = (() => {
  if (!/^https?:\/\//i.test(API_URL)) return undefined;
  try {
    return new URL(API_URL).origin;
  } catch {
    return undefined;
  }
})();

/** What /auth/login, /auth/refresh and /auth/kiosk/(un)lock return. */
export interface SessionPayload {
  access_token: string;
  user: User;
  kiosk_locked: boolean;
}

export { EXPIRED_EVENT, KIOSK_LOCKED_EVENT, SESSION_EVENT };

// The access token lives only in memory. The refresh token is an httpOnly
// cookie the server sets; JavaScript never sees it.
let accessToken: string | null = null;

export function getAccessToken(): string | null {
  return accessToken;
}

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const hit = document.cookie.split("; ").find((c) => c.startsWith(`${name}=`));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : null;
}

/** The double-submit CSRF cookie the server sets next to the refresh cookie. */
export const CSRF_COOKIE = "csrf_refresh_token";

/** True when there may be a refresh cookie to restore a session from. */
export function hasRefreshCookie(): boolean {
  return !!readCookie(CSRF_COOKIE);
}

export const api = axios.create({ baseURL: API_URL, withCredentials: true });

type RetryConfig = InternalAxiosRequestConfig & { _retried?: boolean };

const path = (url?: string) => (url ?? "").replace(/^https?:\/\/[^/]+/i, "").replace(API_URL, "");
const isAuthPath = (url?: string) => /(^|\/)auth\//.test(path(url));
// Never refresh-and-retry these: a 401 from them is the real answer.
const NO_RETRY = /(^|\/)auth\/(login|refresh|logout)$/;

api.interceptors.request.use((config) => {
  const url = path(config.url);
  // The refresh endpoint authenticates with the cookie; a Bearer access token there would be read as the refresh token.
  if (accessToken && !/(^|\/)auth\/refresh$/.test(url)) config.headers.Authorization = `Bearer ${accessToken}`;
  if (isAuthPath(url)) {
    const csrf = readCookie(CSRF_COOKIE);
    if (csrf) config.headers["X-CSRF-TOKEN"] = csrf;
  }
  return config;
});

/** A refresh that failed because the session is really over (not a network blip). */
export function isAuthFailure(err: unknown): boolean {
  const status = (err as AxiosError)?.response?.status;
  return status === 401 || status === 422;
}

function emit(name: string, detail?: unknown) {
  window.dispatchEvent(detail === undefined ? new Event(name) : new CustomEvent(name, { detail }));
}

let refreshing: Promise<SessionPayload> | null = null;

/**
 * Exchanges the refresh cookie for a new access token. Single-flight: callers
 * that arrive while a refresh is running share it. Rejects with the axios
 * error; use isAuthFailure() to tell "signed out" from "server unreachable".
 */
export function refreshSession(): Promise<SessionPayload> {
  refreshing ??= api
    .post<SessionPayload>("/auth/refresh")
    .then((res) => {
      accessToken = res.data.access_token;
      emit(SESSION_EVENT, res.data);
      return res.data;
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

/**
 * refreshSession(), but a definitive rejection (401/422) also ends the local
 * session. Network errors and 5xx keep it: a kiosk must survive a Wi-Fi blip.
 */
export async function refreshOrExpire(): Promise<SessionPayload> {
  try {
    return await refreshSession();
  } catch (err) {
    if (isAuthFailure(err)) {
      accessToken = null;
      emit(EXPIRED_EVENT);
    }
    throw err;
  }
}

api.interceptors.response.use(
  (res) => res,
  async (error: AxiosError<any>) => {
    const original = error.config as RetryConfig | undefined;
    const status = error.response?.status;
    if (status === 403 && error.response?.data?.code === "KIOSK_LOCKED") emit(KIOSK_LOCKED_EVENT);
    // 401 covers both an expired access token and TOKEN_REVOKED: one refresh decides which.
    if (status === 401 && original && !original._retried && !NO_RETRY.test(path(original.url))) {
      original._retried = true;
      let session: SessionPayload;
      try {
        session = await refreshOrExpire();
      } catch {
        return Promise.reject(error);
      }
      original.headers.Authorization = `Bearer ${session.access_token}`;
      return api(original);
    }
    return Promise.reject(error);
  }
);

/** Seconds the server asked us to wait (429), if any. */
export function retryAfterSeconds(err: unknown): number | null {
  const res = (err as AxiosError<any>)?.response;
  if (!res) return null;
  const fromBody = Number(res.data?.retry_after);
  if (Number.isFinite(fromBody) && fromBody > 0) return Math.ceil(fromBody);
  const header = Number((res.headers as any)?.["retry-after"]);
  return Number.isFinite(header) && header > 0 ? Math.ceil(header) : null;
}

function waitText(seconds: number) {
  if (seconds < 90) return `${seconds} seconds`;
  return `${Math.ceil(seconds / 60)} minutes`;
}

export function errorMessage(err: unknown, fallback = "Something went wrong."): string {
  const e = err as AxiosError<any>;
  if (!e?.response) return "Can't reach the server. Check the connection.";
  if (e.response.status === 429) {
    const wait = retryAfterSeconds(e);
    return wait ? `Too many attempts. Try again in ${waitText(wait)}.` : "Too many attempts. Try again shortly.";
  }
  return e.response.data?.error || fallback;
}

export async function downloadFile(url: string, params: Record<string, string | undefined>, fallbackName: string) {
  const res = await api.get(url, { params, responseType: "blob" });
  const disposition = res.headers["content-disposition"] as string | undefined;
  const name = disposition?.match(/filename="?([^"]+)"?/)?.[1] || fallbackName;
  const href = URL.createObjectURL(res.data);
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

export default api;
