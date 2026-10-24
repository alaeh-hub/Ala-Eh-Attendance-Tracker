import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { useAuthStore } from "./stores/authStore";
import { admin, maria } from "./test/fixtures";
import type { User } from "./types";

const { get, post, refreshSession, hasRefreshCookie } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  refreshSession: vi.fn(),
  hasRefreshCookie: vi.fn(),
}));
vi.mock("./services/api", () => ({
  default: { get, post, patch: vi.fn(), delete: vi.fn() },
  api: { get, post, patch: vi.fn(), delete: vi.fn() },
  errorMessage: (_e: unknown, fallback?: string) => fallback ?? "error",
  retryAfterSeconds: () => null,
  downloadFile: vi.fn(),
  API_URL: "/api",
  SOCKET_URL: undefined,
  getAccessToken: () => "token",
  setAccessToken: vi.fn(),
  refreshSession,
  refreshOrExpire: refreshSession,
  hasRefreshCookie,
  isAuthFailure: (err: any) => err?.response?.status === 401 || err?.response?.status === 422,
}));

const kioskDevice: User = { ...admin, id: "kiosk-1", full_name: "Front gate", role: "KIOSK" };

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>
  );
}

function signIn(user: User | null, kioskLocked = false) {
  useAuthStore.setState({ user, kioskLocked, status: "ready" });
}

describe("route guards", () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    refreshSession.mockReset();
    hasRefreshCookie.mockReset().mockReturnValue(false);
    // The Records page's endpoints answer with plain arrays; the other pages read a page object.
    get.mockImplementation(async (url: string) => ({
      data: ["/attendance", "/reports/daily", "/users/departments"].includes(url) ? [] : { items: [], total: 0, pending_count: 0 },
      headers: {},
    }));
    post.mockResolvedValue({ data: {} });
    signIn(null);
  });

  it("sends a signed-out visitor to the sign-in page", async () => {
    renderAt("/admin/review");
    expect(await screen.findByText("Sign in to the Ala Eh! attendance system")).toBeInTheDocument();
  });

  it("restores the session from the refresh cookie without flashing the sign-in page", async () => {
    useAuthStore.setState({ user: null, kioskLocked: false, status: "loading" });
    hasRefreshCookie.mockReturnValue(true);
    let resolve!: (v: unknown) => void;
    refreshSession.mockReturnValue(new Promise((r) => (resolve = r)));
    renderAt("/records");
    expect(screen.getByText(/Loading/)).toBeInTheDocument();
    expect(screen.queryByText("Sign in to the Ala Eh! attendance system")).not.toBeInTheDocument();
    resolve({ access_token: "t", user: maria, kiosk_locked: false });
    expect(await screen.findAllByText("My attendance")).not.toHaveLength(0);
  });

  it("shows a retry screen, not the sign-in page, while the server is unreachable", async () => {
    useAuthStore.setState({ user: null, kioskLocked: false, status: "loading" });
    hasRefreshCookie.mockReturnValue(true);
    refreshSession.mockRejectedValue(new Error("Network Error"));
    renderAt("/kiosk");
    expect(await screen.findByText(/Can't reach the server/)).toBeInTheDocument();
    expect(screen.queryByText("Sign in to the Ala Eh! attendance system")).not.toBeInTheDocument();
  });

  it("lets an admin open the review page", async () => {
    signIn(admin);
    renderAt("/admin/review");
    expect(await screen.findByText("Scan review")).toBeInTheDocument();
  });

  it("keeps staff out of admin pages and sends them to their own attendance", async () => {
    signIn(maria);
    renderAt("/admin/review");
    expect(screen.queryByText("Scan review")).not.toBeInTheDocument();
    expect(await screen.findAllByText("My attendance")).not.toHaveLength(0);
  });

  it("never shows the kiosk to staff", async () => {
    signIn(maria);
    renderAt("/kiosk");
    expect(await screen.findAllByText("My attendance")).not.toHaveLength(0);
    expect(screen.queryByText("Open kiosk")).not.toBeInTheDocument();
    expect(post).not.toHaveBeenCalledWith("/auth/kiosk/lock");
  });

  it("keeps every route on the kiosk while the session is kiosk-locked", async () => {
    signIn(admin, true);
    renderAt("/admin/review");
    expect(screen.queryByText("Scan review")).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Back to admin" })).toBeInTheDocument();
  });

  it("locks the session on the server when the kiosk opens", async () => {
    signIn(admin);
    post.mockResolvedValue({ data: { access_token: "locked", user: admin, kiosk_locked: true } });
    renderAt("/kiosk");
    await waitFor(() => expect(post).toHaveBeenCalledWith("/auth/kiosk/lock"));
    expect(await screen.findByRole("button", { name: "Back to admin" })).toBeInTheDocument();
    expect(useAuthStore.getState().kioskLocked).toBe(true);
  });

  it("leaves the kiosk for the admin portal after the password is accepted, without re-locking", async () => {
    signIn(admin, true);
    post.mockImplementation(async (url: string) => {
      if (url === "/auth/kiosk/unlock") return { data: { access_token: "open", user: admin, kiosk_locked: false } };
      if (url === "/auth/kiosk/lock") return { data: { access_token: "locked", user: admin, kiosk_locked: true } };
      return { data: {} };
    });
    renderAt("/kiosk");
    await userEvent.click(await screen.findByRole("button", { name: "Back to admin" }));
    await userEvent.type(await screen.findByLabelText("Password"), "admin123");
    await userEvent.click(screen.getByRole("button", { name: /Unlock/ }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/auth/kiosk/unlock", { password: "admin123" }));
    // Give any stray effect time to fire; none may lock the session again.
    await new Promise((r) => setTimeout(r, 300));
    expect(post).not.toHaveBeenCalledWith("/auth/kiosk/lock");
    expect(useAuthStore.getState().kioskLocked).toBe(false);
    expect(screen.queryByRole("button", { name: "Back to admin" })).not.toBeInTheDocument();
  });

  it("sends a KIOSK device account straight to the kiosk, with no way out", async () => {
    signIn(kioskDevice, true);
    renderAt("/");
    expect(await screen.findByText("Kiosk device")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back to admin" })).not.toBeInTheDocument();
  });
});
