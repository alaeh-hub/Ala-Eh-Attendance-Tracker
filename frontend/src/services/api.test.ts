import type { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import api, { API_URL, errorMessage, getAccessToken, refreshSession, retryAfterSeconds, setAccessToken } from "./api";
import { EXPIRED_EVENT, KIOSK_LOCKED_EVENT, SESSION_EVENT } from "./authEvents";
import { admin } from "../test/fixtures";

type Handler = (config: InternalAxiosRequestConfig) => Promise<AxiosResponse> | AxiosResponse;

const seen: InternalAxiosRequestConfig[] = [];
let handler: Handler;

function respond(config: InternalAxiosRequestConfig, status: number, data: unknown = {}): AxiosResponse {
  const res = { data, status, statusText: String(status), headers: {}, config } as AxiosResponse;
  if (status >= 400) {
    throw Object.assign(new Error(`HTTP ${status}`), { isAxiosError: true, config, response: res });
  }
  return res;
}

function networkError(config: InternalAxiosRequestConfig): never {
  throw Object.assign(new Error("Network Error"), { isAxiosError: true, config, code: "ERR_NETWORK" });
}

const adapter: AxiosAdapter = async (config) => {
  seen.push(config);
  return handler(config);
};

const session = (token: string) => ({ access_token: token, user: admin, kiosk_locked: false });
const urlOf = (c: InternalAxiosRequestConfig) => c.url ?? "";
const authOf = (c: InternalAxiosRequestConfig) => (c.headers as any)?.Authorization ?? (c.headers as any)?.get?.("Authorization");
const headerOf = (c: InternalAxiosRequestConfig, name: string) => (c.headers as any)?.[name] ?? (c.headers as any)?.get?.(name);

describe("api client", () => {
  const original = api.defaults.adapter;
  beforeEach(() => {
    seen.length = 0;
    api.defaults.adapter = adapter;
    setAccessToken(null);
    document.cookie = "csrf_refresh_token=csrf-123; path=/";
  });
  afterEach(() => {
    api.defaults.adapter = original;
    document.cookie = "csrf_refresh_token=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  });

  it("talks to the same-origin /api with cookies enabled", () => {
    // A local .env may point elsewhere; without one the default is the relative /api.
    expect(API_URL).toBe(import.meta.env.VITE_API_URL || "/api");
    expect(api.defaults.baseURL).toBe(API_URL);
    expect(api.defaults.withCredentials).toBe(true);
  });

  it("sends the in-memory access token, and never stores it", async () => {
    setAccessToken("tok-1");
    handler = (c) => respond(c, 200, []);
    await api.get("/users");
    expect(authOf(seen[0])).toBe("Bearer tok-1");
    expect(localStorage.length).toBe(0);
  });

  it("refreshes with the CSRF header and the cookie, not a bearer token", async () => {
    setAccessToken("old");
    handler = (c) => respond(c, 200, session("new"));
    const s = await refreshSession();
    expect(s.access_token).toBe("new");
    expect(getAccessToken()).toBe("new");
    expect(urlOf(seen[0])).toBe("/auth/refresh");
    expect(headerOf(seen[0], "X-CSRF-TOKEN")).toBe("csrf-123");
    expect(authOf(seen[0])).toBeFalsy();
  });

  it("refreshes once for concurrent 401s and retries each request with the new token", async () => {
    setAccessToken("expired");
    const onSession = vi.fn();
    window.addEventListener(SESSION_EVENT, onSession);
    handler = async (c) => {
      if (urlOf(c) === "/auth/refresh") {
        await new Promise((r) => setTimeout(r, 10));
        return respond(c, 200, session("fresh"));
      }
      return authOf(c) === "Bearer fresh" ? respond(c, 200, { ok: urlOf(c) }) : respond(c, 401, { error: "expired" });
    };
    const [a, b] = await Promise.all([api.get("/a"), api.get("/b")]);
    window.removeEventListener(SESSION_EVENT, onSession);
    expect(a.data).toEqual({ ok: "/a" });
    expect(b.data).toEqual({ ok: "/b" });
    expect(seen.filter((c) => urlOf(c) === "/auth/refresh")).toHaveLength(1);
    expect(onSession).toHaveBeenCalledTimes(1);
  });

  it("treats TOKEN_REVOKED like expiry: one refresh, then the retry", async () => {
    setAccessToken("revoked");
    handler = (c) => {
      if (urlOf(c) === "/auth/refresh") return respond(c, 200, session("fresh"));
      return authOf(c) === "Bearer fresh" ? respond(c, 200, "ok") : respond(c, 401, { error: "revoked", code: "TOKEN_REVOKED" });
    };
    await expect(api.get("/x")).resolves.toMatchObject({ data: "ok" });
  });

  it("ends the session when the refresh itself is rejected (401)", async () => {
    setAccessToken("expired");
    const onExpired = vi.fn();
    window.addEventListener(EXPIRED_EVENT, onExpired);
    handler = (c) => respond(c, 401, { error: "nope" });
    await expect(api.get("/x")).rejects.toMatchObject({ response: { status: 401 } });
    window.removeEventListener(EXPIRED_EVENT, onExpired);
    expect(onExpired).toHaveBeenCalledTimes(1);
    expect(getAccessToken()).toBeNull();
  });

  it("keeps the session when the refresh fails on the network (a Wi-Fi blip)", async () => {
    setAccessToken("expired");
    const onExpired = vi.fn();
    window.addEventListener(EXPIRED_EVENT, onExpired);
    handler = (c) => (urlOf(c) === "/auth/refresh" ? networkError(c) : respond(c, 401, { error: "expired" }));
    await expect(api.get("/x")).rejects.toMatchObject({ response: { status: 401 } });
    window.removeEventListener(EXPIRED_EVENT, onExpired);
    expect(onExpired).not.toHaveBeenCalled();
    expect(getAccessToken()).toBe("expired");
  });

  it("keeps the session when the refresh gets a 5xx", async () => {
    setAccessToken("expired");
    const onExpired = vi.fn();
    window.addEventListener(EXPIRED_EVENT, onExpired);
    handler = (c) => (urlOf(c) === "/auth/refresh" ? respond(c, 503) : respond(c, 401));
    await expect(api.get("/x")).rejects.toBeTruthy();
    window.removeEventListener(EXPIRED_EVENT, onExpired);
    expect(onExpired).not.toHaveBeenCalled();
  });

  it("does not refresh-and-retry a failed login", async () => {
    handler = (c) => respond(c, 401, { error: "Invalid email or password" });
    await expect(api.post("/auth/login", {})).rejects.toBeTruthy();
    expect(seen.map(urlOf)).toEqual(["/auth/login"]);
  });

  it("announces a kiosk-locked session (403 KIOSK_LOCKED)", async () => {
    setAccessToken("kiosk");
    const onLocked = vi.fn();
    window.addEventListener(KIOSK_LOCKED_EVENT, onLocked);
    handler = (c) => respond(c, 403, { error: "Kiosk mode", code: "KIOSK_LOCKED" });
    await expect(api.get("/users")).rejects.toBeTruthy();
    window.removeEventListener(KIOSK_LOCKED_EVENT, onLocked);
    expect(onLocked).toHaveBeenCalledTimes(1);
  });

  it("explains 429s with the server's retry time", () => {
    const err = { response: { status: 429, data: { error: "Too many", retry_after: 120 }, headers: {} } };
    expect(retryAfterSeconds(err)).toBe(120);
    expect(errorMessage(err)).toBe("Too many attempts. Try again in 2 minutes.");
    expect(errorMessage({ response: { status: 429, data: {}, headers: { "retry-after": "30" } } })).toBe("Too many attempts. Try again in 30 seconds.");
    expect(errorMessage(new Error("Network Error"))).toBe("Can't reach the server. Check the connection.");
  });
});
