import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { admin } from "../test/fixtures";
import api, { getAccessToken, setAccessToken } from "../services/api";
import { EXPIRED_EVENT } from "../services/authEvents";
import { useAuthStore } from "./authStore";
import { toast, useToastStore } from "./toastStore";

describe("toastStore", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useToastStore.setState({ toasts: [] });
  });
  afterEach(() => vi.useRealTimers());

  it("queues a toast and removes it after its timeout", () => {
    toast.success("Saved", "All good");
    expect(useToastStore.getState().toasts).toMatchObject([{ tone: "success", title: "Saved", message: "All good" }]);
    vi.advanceTimersByTime(4000);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("keeps error toasts on screen longer than success toasts", () => {
    toast.error("Failed");
    vi.advanceTimersByTime(4000);
    expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(2500);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("shows at most four toasts, dropping the oldest", () => {
    for (let i = 1; i <= 6; i++) toast.info(`n${i}`);
    expect(useToastStore.getState().toasts.map((t) => t.title)).toEqual(["n3", "n4", "n5", "n6"]);
  });
});

describe("authStore", () => {
  const original = api.defaults.adapter;
  const calls: string[] = [];
  let reply: (url: string) => { status: number; data?: unknown } | "network";

  beforeEach(() => {
    calls.length = 0;
    reply = () => ({ status: 200, data: {} });
    api.defaults.adapter = async (config) => {
      calls.push(config.url ?? "");
      const r = reply(config.url ?? "");
      if (r === "network") throw Object.assign(new Error("Network Error"), { isAxiosError: true, config });
      const res = { data: r.data ?? {}, status: r.status, statusText: "", headers: {}, config };
      if (r.status >= 400) throw Object.assign(new Error(`HTTP ${r.status}`), { isAxiosError: true, config, response: res });
      return res;
    };
    useAuthStore.setState({ user: null, kioskLocked: false, status: "loading" });
    setAccessToken(null);
    document.cookie = "csrf_refresh_token=csrf; path=/";
  });
  afterEach(() => {
    api.defaults.adapter = original;
    document.cookie = "csrf_refresh_token=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  });

  it("keeps the access token in memory only; nothing secret goes to storage", () => {
    useAuthStore.getState().setSession({ access_token: "access", user: admin, kiosk_locked: false });
    expect(useAuthStore.getState().user?.id).toBe(admin.id);
    expect(useAuthStore.getState().status).toBe("ready");
    expect(getAccessToken()).toBe("access");
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it("follows the server's kiosk lock", () => {
    useAuthStore.getState().setSession({ access_token: "a", user: { ...admin, role: "KIOSK" }, kiosk_locked: true });
    expect(useAuthStore.getState().kioskLocked).toBe(true);
  });

  it("revokes the session on the server, then forgets it", async () => {
    useAuthStore.getState().setSession({ access_token: "access", user: admin, kiosk_locked: false });
    await useAuthStore.getState().logout();
    expect(calls).toContain("/auth/logout");
    expect(useAuthStore.getState().user).toBeNull();
    expect(getAccessToken()).toBeNull();
  });

  it("still signs out locally when the server can't be reached", async () => {
    useAuthStore.getState().setSession({ access_token: "access", user: admin, kiosk_locked: false });
    reply = () => "network";
    await useAuthStore.getState().logout();
    expect(useAuthStore.getState().user).toBeNull();
  });

  it("restores the session from the refresh cookie on load", async () => {
    reply = (url) => (url === "/auth/refresh" ? { status: 200, data: { access_token: "fresh", user: admin, kiosk_locked: true } } : { status: 404 });
    await useAuthStore.getState().restore();
    expect(useAuthStore.getState()).toMatchObject({ status: "ready", kioskLocked: true, user: { id: admin.id } });
    expect(getAccessToken()).toBe("fresh");
  });

  it("skips the restore round-trip when there is no session cookie", async () => {
    document.cookie = "csrf_refresh_token=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
    await useAuthStore.getState().restore();
    expect(calls).toEqual([]);
    expect(useAuthStore.getState()).toMatchObject({ status: "ready", user: null });
  });

  it("goes to the sign-in page when the refresh cookie is rejected", async () => {
    reply = () => ({ status: 401, data: { error: "expired" } });
    await useAuthStore.getState().restore();
    expect(useAuthStore.getState()).toMatchObject({ status: "ready", user: null });
  });

  it("reports offline (not signed out) when the server is unreachable", async () => {
    reply = () => "network";
    await useAuthStore.getState().restore();
    expect(useAuthStore.getState().status).toBe("offline");
  });

  it("locks and unlocks the kiosk through the server", async () => {
    useAuthStore.getState().setSession({ access_token: "a", user: admin, kiosk_locked: false });
    reply = (url) => ({ status: 200, data: { access_token: url.endsWith("lock") && !url.endsWith("unlock") ? "locked" : "open", user: admin, kiosk_locked: !url.endsWith("unlock") } });
    await useAuthStore.getState().lockKiosk();
    expect(useAuthStore.getState().kioskLocked).toBe(true);
    expect(getAccessToken()).toBe("locked");
    await useAuthStore.getState().unlockKiosk("pw");
    expect(useAuthStore.getState().kioskLocked).toBe(false);
    expect(calls).toEqual(["/auth/kiosk/lock", "/auth/kiosk/unlock"]);
  });

  it("rejects a wrong unlock password and stays locked", async () => {
    useAuthStore.getState().setSession({ access_token: "a", user: admin, kiosk_locked: true });
    reply = () => ({ status: 403, data: { error: "Wrong password", code: "WRONG_PASSWORD" } });
    await expect(useAuthStore.getState().unlockKiosk("bad")).rejects.toMatchObject({ response: { status: 403 } });
    expect(useAuthStore.getState().kioskLocked).toBe(true);
  });

  it("drops the session when the API layer reports it expired", () => {
    useAuthStore.getState().setSession({ access_token: "a", user: admin, kiosk_locked: false });
    window.dispatchEvent(new Event(EXPIRED_EVENT));
    expect(useAuthStore.getState().user).toBeNull();
  });
});
