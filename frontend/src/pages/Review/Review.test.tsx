import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiError, juan, maria, snapshot } from "../../test/fixtures";
import Review from "./Review";

const { get, post, del } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), del: vi.fn() }));
vi.mock("../../services/api", () => ({
  default: { get, post, delete: del },
  errorMessage: (e: any, fallback?: string) => e?.response?.data?.error ?? fallback ?? "error",
}));

function mockApi(items = [snapshot()], pending = items.length) {
  get.mockImplementation((url: string) => {
    if (url.endsWith("/image")) return Promise.resolve({ data: new Blob(["x"]) });
    if (url === "/review/snapshots") return Promise.resolve({ data: { items, total: items.length, pending_count: pending } });
    if (url === "/users") return Promise.resolve({ data: [maria, juan], headers: { "x-total-count": "2" } });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
}

describe("Review page", () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    del.mockReset();
  });

  it("lists pending scans with the closest employee and score", async () => {
    mockApi([snapshot(), snapshot({ id: "snap-2", status: "SPOOF_SUSPECTED", candidate_name: null, spoof_score: 0.12 })]);
    render(<Review />);

    expect(await screen.findByText("Closest: Maria Santos")).toBeInTheDocument();
    expect(screen.getByText("Unknown face")).toBeInTheDocument();
    expect(screen.getByText("Possible spoof")).toBeInTheDocument();
    expect(screen.getAllByText("score 0.31")).toHaveLength(2);
    expect(screen.getByText("live 0.12")).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith("/review/snapshots", expect.objectContaining({ params: { filter: "pending", limit: 48, offset: 0 } }));
  });

  it("shows an empty state when nothing needs review", async () => {
    mockApi([], 0);
    render(<Review />);
    expect(await screen.findByText("Nothing to review")).toBeInTheDocument();
  });

  it("switches filters and reloads", async () => {
    mockApi();
    render(<Review />);
    await screen.findByText("Closest: Maria Santos");
    await userEvent.click(screen.getByRole("button", { name: "Check-ins" }));
    await waitFor(() => expect(get).toHaveBeenCalledWith("/review/snapshots", expect.objectContaining({ params: { filter: "matched", limit: 48, offset: 0 } })));
  });

  it("dismisses a snapshot", async () => {
    mockApi();
    post.mockResolvedValue({ data: { ok: true, pending_count: 0 } });
    render(<Review />);
    await userEvent.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(post).toHaveBeenCalledWith("/review/snapshots/snap-1/dismiss");
  });

  it("asks for confirmation before deleting a snapshot", async () => {
    mockApi();
    del.mockResolvedValue({ data: { ok: true } });
    render(<Review />);
    await userEvent.click(await screen.findByRole("button", { name: "Delete snapshot" }));
    expect(del).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(del).toHaveBeenCalledWith("/review/snapshots/snap-1");
  });

  it("adds a frame as a sample for the preselected closest employee", async () => {
    mockApi();
    post.mockResolvedValue({ data: { pending_count: 0 } });
    render(<Review />);
    await userEvent.click(await screen.findByRole("button", { name: /Add as sample/ }));

    const dialog = await screen.findByRole("dialog");
    // The closest candidate is preselected in the employee picker.
    expect(within(dialog).getByText(maria.full_name)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Add sample" }));

    expect(post).toHaveBeenCalledWith("/review/snapshots/snap-1/enroll", { user_id: maria.id, consent: false });
  });

  it("asks the admin to confirm consent when none is on file, then retries with it", async () => {
    mockApi();
    post
      .mockRejectedValueOnce(apiError(428, { error: "Record the employee's consent", code: "CONSENT_REQUIRED" }))
      .mockResolvedValueOnce({ data: { pending_count: 0 } });
    render(<Review />);
    await userEvent.click(await screen.findByRole("button", { name: /Add as sample/ }));

    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add sample" }));

    expect(await within(dialog).findByText(/No biometric consent is on file/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: /Employee consented/ }));
    await waitFor(() => expect(post).toHaveBeenLastCalledWith("/review/snapshots/snap-1/enroll", { user_id: maria.id, consent: true }));
  });

  it("offers no review actions on a matched check-in", async () => {
    mockApi([snapshot({ status: "MATCHED", user_id: maria.id, user_name: maria.full_name, candidate_name: null })]);
    render(<Review />);
    expect(await screen.findByText("Maria Santos")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add as sample/ })).not.toBeInTheDocument();
  });

  it("never offers to enroll a suspected spoof", async () => {
    mockApi([snapshot({ status: "SPOOF_SUSPECTED", spoof_score: 0.05 })]);
    render(<Review />);
    expect(await screen.findByText("Possible spoof")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add as sample/ })).not.toBeInTheDocument();
    expect(screen.getByText(/can't be added as a face sample/)).toBeInTheDocument();
    // It can still be dismissed.
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  });

  it("explains when the server refuses a frame (409) instead of a generic error", async () => {
    mockApi();
    post.mockRejectedValueOnce(apiError(409, { error: "This frame was flagged as a possible spoof." }));
    render(<Review />);
    await userEvent.click(await screen.findByRole("button", { name: /Add as sample/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Add sample" }));
    expect(await within(dialog).findByText(/the server refused this frame/)).toBeInTheDocument();
    expect(within(dialog).getByText("This frame was flagged as a possible spoof.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Add sample" })).toBeDisabled();
  });

  it("sends a dismiss only once on a double click", async () => {
    mockApi();
    let resolve: (v: unknown) => void = () => undefined;
    post.mockImplementation(() => new Promise((r) => (resolve = r)));
    render(<Review />);
    const btn = await screen.findByRole("button", { name: "Dismiss" });
    await userEvent.dblClick(btn);
    expect(post).toHaveBeenCalledTimes(1);
    resolve({ data: { ok: true, pending_count: 0 } });
    await waitFor(() => expect(screen.getByText("Nothing to review")).toBeInTheDocument());
  });

  it("loads more snapshots from the next offset", async () => {
    const first = Array.from({ length: 2 }, (_, i) => snapshot({ id: `snap-${i}` }));
    get.mockImplementation((url: string, cfg?: { params?: { offset?: number } }) => {
      if (url.endsWith("/image")) return Promise.resolve({ data: new Blob(["x"]) });
      if (url === "/review/snapshots") {
        const items = cfg?.params?.offset ? [snapshot({ id: "snap-9", candidate_name: "Juan Dela Cruz" })] : first;
        return Promise.resolve({ data: { items, total: 3, pending_count: 3 } });
      }
      return Promise.reject(new Error(`unexpected GET ${url}`));
    });
    render(<Review />);
    expect(await screen.findByText("Showing 2 of 3")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Load more/ }));
    expect(await screen.findByText("Closest: Juan Dela Cruz")).toBeInTheDocument();
    expect(get).toHaveBeenCalledWith("/review/snapshots", expect.objectContaining({ params: { filter: "pending", limit: 48, offset: 2 } }));
    expect(screen.queryByRole("button", { name: /Load more/ })).not.toBeInTheDocument();
  });
});
