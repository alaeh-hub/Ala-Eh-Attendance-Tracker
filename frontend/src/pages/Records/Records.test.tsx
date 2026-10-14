import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "../../stores/authStore";
import { admin, juan, maria } from "../../test/fixtures";
import type { AttendanceEvent } from "../../types";
import { orgDate } from "../../utils/orgTime";
import Records from "./Records";

const { get, post, patch, del } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() }));
vi.mock("../../services/api", () => ({
  default: { get, post, patch, delete: del },
  downloadFile: vi.fn(),
  errorMessage: (e: any, fallback?: string) => e?.response?.data?.error ?? fallback ?? "error",
}));

function event(over: Partial<AttendanceEvent> = {}): AttendanceEvent {
  return {
    id: "ev-1",
    user_id: maria.id,
    user_name: maria.full_name,
    employee_code: maria.employee_code,
    department: maria.department,
    has_photo: false,
    event_type: "CLOCK_IN",
    session: "AM",
    timestamp: "2026-10-14T00:05:00Z",
    match_score: 0.9,
    match_status: "MATCHED",
    liveness_passed: true,
    device_id: "kiosk-1",
    notes: null,
    ...over,
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("Records page", () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    patch.mockReset();
    del.mockReset();
    useAuthStore.setState({ user: admin });
  });

  it("sends a manual entry as naive org-local wall time (no browser timezone conversion)", async () => {
    get.mockImplementation((url: string) => {
      if (url === "/users") return Promise.resolve({ data: [maria, juan], headers: { "x-total-count": "2" } });
      return Promise.resolve({ data: [], headers: {} });
    });
    post.mockResolvedValue({ data: {} });
    render(<Records />);

    await userEvent.click(screen.getByRole("button", { name: /Manual entry/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(await within(dialog).findByRole("option", { name: /Maria Santos/ }));
    fireEvent.change(within(dialog).getByLabelText(/^Date & time/), { target: { value: "2026-10-14T08:05" } });
    await userEvent.type(within(dialog).getByLabelText(/^Reason/), "Kiosk camera offline");
    await userEvent.click(within(dialog).getByRole("button", { name: /Save entry/ }));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [url, body] = post.mock.calls[0];
    expect(url).toBe("/attendance");
    expect(body).toMatchObject({ user_id: maria.id, event_type: "CLOCK_IN", timestamp: "2026-10-14T08:05:00", notes: "Kiosk camera offline" });
  });

  it("asks for an employee and a reason before saving a manual entry", async () => {
    get.mockResolvedValue({ data: [], headers: {} });
    render(<Records />);
    await userEvent.click(screen.getByRole("button", { name: /Manual entry/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: /Save entry/ }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(/Choose an employee/);
    expect(post).not.toHaveBeenCalled();
  });

  it("ignores a slow response for an older filter", async () => {
    const today = orgDate(0);
    const slow = deferred<unknown>();
    get.mockImplementation((url: string, cfg?: { params?: Record<string, unknown> }) => {
      if (url === "/attendance") {
        // The first (today) request answers last, after the newer one.
        if (cfg?.params?.from === today) return slow.promise;
        return Promise.resolve({ data: [event({ id: "ev-new", user_id: juan.id, user_name: juan.full_name })], headers: { "x-total-count": "1" } });
      }
      return Promise.resolve({ data: [], headers: {} });
    });
    render(<Records />);

    await userEvent.click(screen.getByRole("tab", { name: "Scan log" }));
    await waitFor(() => expect(get).toHaveBeenCalledWith("/attendance", expect.objectContaining({ params: expect.objectContaining({ from: today, limit: 100, offset: 0 }) })));
    await userEvent.click(screen.getByRole("button", { name: "Yesterday" }));
    expect(await screen.findByText("Juan Dela Cruz")).toBeInTheDocument();

    slow.resolve({ data: [event({ id: "ev-old" })], headers: { "x-total-count": "1" } });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("Maria Santos")).not.toBeInTheDocument();
    expect(screen.getByText("Juan Dela Cruz")).toBeInTheDocument();
  });

  it("pages the scan log with limit/offset and the total from X-Total-Count", async () => {
    get.mockImplementation((url: string, cfg?: { params?: Record<string, unknown> }) => {
      if (url === "/attendance") {
        const offset = Number(cfg?.params?.offset ?? 0);
        return Promise.resolve({ data: [event({ id: `ev-${offset}` })], headers: { "x-total-count": "150" } });
      }
      return Promise.resolve({ data: [], headers: {} });
    });
    render(<Records />);
    await userEvent.click(screen.getByRole("tab", { name: "Scan log" }));
    expect(await screen.findByText(/Showing/)).toHaveTextContent("Showing 1–1 of 150 scans");
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(get).toHaveBeenCalledWith("/attendance", expect.objectContaining({ params: expect.objectContaining({ offset: 100, limit: 100 }) })));
    // An empty department is never sent as `department=""`.
    for (const [, cfg] of get.mock.calls) expect(cfg?.params ?? {}).not.toHaveProperty("department");
  });
});
