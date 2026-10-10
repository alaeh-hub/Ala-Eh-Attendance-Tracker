import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { admin } from "../test/fixtures";
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
  beforeEach(() => {
    localStorage.clear();
    useAuthStore.setState({ user: null });
  });

  it("stores the session in localStorage so a reload keeps it", () => {
    useAuthStore.getState().setSession(admin, "access", "refresh");
    expect(useAuthStore.getState().user?.id).toBe(admin.id);
    expect(localStorage.getItem("access_token")).toBe("access");
    expect(localStorage.getItem("refresh_token")).toBe("refresh");
    expect(JSON.parse(localStorage.getItem("auth_user")!).email).toBe(admin.email);
  });

  it("clears everything on logout", () => {
    useAuthStore.getState().setSession(admin, "access", "refresh");
    useAuthStore.getState().logout();
    expect(useAuthStore.getState().user).toBeNull();
    expect(localStorage.getItem("access_token")).toBeNull();
    expect(localStorage.getItem("refresh_token")).toBeNull();
    expect(localStorage.getItem("auth_user")).toBeNull();
  });
});
