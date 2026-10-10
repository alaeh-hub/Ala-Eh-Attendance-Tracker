import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { useAuthStore } from "./stores/authStore";
import { admin, maria } from "./test/fixtures";
import { lockKiosk, unlockKiosk } from "./utils/kioskLock";

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("./services/api", () => ({
  default: { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  errorMessage: (_e: unknown, fallback?: string) => fallback ?? "error",
  API_URL: "http://test/api",
  SOCKET_URL: "http://test",
}));

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>
  );
}

describe("route guards", () => {
  beforeEach(() => {
    get.mockReset();
    get.mockResolvedValue({ data: { items: [], total: 0, pending_count: 0 } });
    useAuthStore.setState({ user: null });
    localStorage.clear();
    unlockKiosk();
  });

  it("sends a signed-out visitor to the sign-in page", async () => {
    renderAt("/admin/review");
    expect(await screen.findByText("Sign in to the Ala Eh! attendance system")).toBeInTheDocument();
  });

  it("lets an admin open the review page", async () => {
    useAuthStore.setState({ user: admin });
    renderAt("/admin/review");
    expect(await screen.findByText("Scan review")).toBeInTheDocument();
  });

  it("keeps staff out of admin pages and sends them to their own attendance", async () => {
    useAuthStore.setState({ user: maria });
    renderAt("/admin/review");
    expect(screen.queryByText("Scan review")).not.toBeInTheDocument();
    expect(await screen.findByText("My attendance")).toBeInTheDocument();
  });

  it("keeps the admin portal locked while the kiosk is up", async () => {
    useAuthStore.setState({ user: admin });
    lockKiosk();
    renderAt("/admin/review");
    expect(screen.queryByText("Scan review")).not.toBeInTheDocument();
    expect(await screen.findByText("Start camera")).toBeInTheDocument();
  });
});
