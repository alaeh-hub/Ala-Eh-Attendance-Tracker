import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAuthStore } from "../../stores/authStore";
import { useToastStore } from "../../stores/toastStore";
import { admin, juan, maria } from "../../test/fixtures";
import Employees from "./Employees";

function lastToast() {
  const toasts = useToastStore.getState().toasts;
  return toasts[toasts.length - 1];
}

const { get, post, patch, del } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn(), del: vi.fn() }));
vi.mock("../../services/api", () => ({
  default: { get, post, patch, delete: del },
  errorMessage: (e: any, fallback?: string) => e?.response?.data?.error ?? fallback ?? "error",
}));

function setup(role: "ADMIN" | "OPERATOR" = "ADMIN") {
  useAuthStore.setState({ user: { ...admin, role } });
  get.mockImplementation((url: string) => {
    if (url === "/users") return Promise.resolve({ data: [admin, maria, juan] });
    if (url === "/departments") return Promise.resolve({ data: [] });
    return Promise.reject(new Error(`unexpected GET ${url}`));
  });
  return render(
    <MemoryRouter>
      <Employees />
    </MemoryRouter>
  );
}

describe("Employees page", () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    patch.mockReset();
    del.mockReset();
  });

  it("lists employees with their face-enrollment state", async () => {
    setup();
    expect(await screen.findByText("Maria Santos")).toBeInTheDocument();
    expect(screen.getByText("Juan Dela Cruz")).toBeInTheDocument();
    expect(screen.getByText("Not enrolled — enroll")).toBeInTheDocument();
    expect(screen.getByText(/3 people · 3 active · 2 face-enrolled/)).toBeInTheDocument();
  });

  it("filters with the smart search", async () => {
    setup();
    await screen.findByText("Maria Santos");
    await userEvent.type(screen.getByPlaceholderText(/Search name/), "juan");
    expect(screen.queryByText("Maria Santos")).not.toBeInTheDocument();
    expect(screen.getByText("Juan Dela Cruz")).toBeInTheDocument();
  });

  it("clears all data only after the password and DELETE are entered", async () => {
    setup();
    post.mockResolvedValue({
      data: { users_removed: 2, face_samples: 12, review_snapshots: 3, attendance_events: 40, kept: { admins: 1, operators: 0, kiosks: 0, departments: 2 } },
    });
    await screen.findByText("Maria Santos");

    await userEvent.click(screen.getByRole("button", { name: /Clear all data/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/cannot be undone/)).toBeInTheDocument();
    expect(within(dialog).getByText("Administrator accounts")).toBeInTheDocument();
    expect(within(dialog).getByText("Departments and their settings")).toBeInTheDocument();

    const confirmBtn = within(dialog).getByRole("button", { name: "Delete everything" });
    expect(confirmBtn).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText("Your password"), "secret-pass");
    expect(confirmBtn).toBeDisabled(); // still needs DELETE
    await userEvent.type(within(dialog).getByPlaceholderText("DELETE"), "delete");
    expect(confirmBtn).toBeDisabled(); // case matters
    await userEvent.clear(within(dialog).getByPlaceholderText("DELETE"));
    await userEvent.type(within(dialog).getByPlaceholderText("DELETE"), "DELETE");
    expect(confirmBtn).toBeEnabled();
    expect(post).not.toHaveBeenCalled();

    // Once it has run, the list is reloaded from the server: only the admin is left.
    get.mockImplementation((url: string) => (url === "/users" ? Promise.resolve({ data: [admin] }) : Promise.resolve({ data: [] })));
    await userEvent.click(confirmBtn);
    await waitFor(() =>
      expect(post).toHaveBeenCalledWith("/admin/clear-all-data", { confirm: "DELETE", password: "secret-pass", keep_operators: true })
    );
    await waitFor(() => expect(screen.queryByText("Maria Santos")).not.toBeInTheDocument());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("can also remove operator accounts when asked", async () => {
    setup();
    post.mockResolvedValue({ data: { users_removed: 3, face_samples: 0, review_snapshots: 0, attendance_events: 0, kept: { admins: 1, operators: 0, kiosks: 0, departments: 0 } } });
    await screen.findByText("Maria Santos");
    await userEvent.click(screen.getByRole("button", { name: /Clear all data/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByLabelText("Also delete operator and kiosk device accounts"));
    await userEvent.type(within(dialog).getByLabelText("Your password"), "secret-pass");
    await userEvent.type(within(dialog).getByPlaceholderText("DELETE"), "DELETE");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete everything" }));
    await waitFor(() => expect(post).toHaveBeenCalledWith("/admin/clear-all-data", expect.objectContaining({ keep_operators: false })));
  });

  it("shows the server's message and keeps the data when the password is wrong", async () => {
    setup();
    post.mockRejectedValue({ response: { status: 403, data: { error: "Incorrect password." } } });
    await screen.findByText("Maria Santos");
    await userEvent.click(screen.getByRole("button", { name: /Clear all data/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Your password"), "nope");
    await userEvent.type(within(dialog).getByPlaceholderText("DELETE"), "DELETE");
    await userEvent.click(within(dialog).getByRole("button", { name: "Delete everything" }));
    expect(await within(dialog).findByText("Incorrect password.")).toBeInTheDocument();
    expect(screen.getByText("Maria Santos")).toBeInTheDocument();
  });

  it("keeps the data when the confirmation is cancelled", async () => {
    setup();
    await screen.findByText("Maria Santos");
    await userEvent.click(screen.getByRole("button", { name: /Clear all data/ }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(post).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(screen.getByText(/2 face-enrolled/)).toBeInTheDocument();
  });

  it("hides the clear-all button from non-admins", async () => {
    setup("OPERATOR");
    await screen.findByText("Maria Santos");
    expect(screen.queryByRole("button", { name: /Clear all data/ })).not.toBeInTheDocument();
  });

  it("asks before deleting an employee and explains archiving", async () => {
    setup();
    del.mockResolvedValue({ data: { deleted: true, archived: false, id: maria.id } });
    await screen.findByText("Maria Santos");
    await userEvent.click(screen.getByRole("button", { name: "Delete Maria Santos" }));
    expect(await screen.findByText(/attendance records are kept for payroll/)).toBeInTheDocument();
    expect(del).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Delete employee" }));
    await waitFor(() => expect(del).toHaveBeenCalledWith(`/users/${maria.id}`));
    await waitFor(() => expect(screen.queryByText("Maria Santos")).not.toBeInTheDocument());
    expect(lastToast()?.title).toBe("Employee deleted");
  });

  it("keeps an archived employee in the list as deactivated and says so", async () => {
    setup();
    del.mockResolvedValue({ data: { deleted: false, archived: true, id: maria.id } });
    await screen.findByText("Maria Santos");
    await userEvent.click(screen.getByRole("button", { name: "Delete Maria Santos" }));
    await userEvent.click(await screen.findByRole("button", { name: "Delete employee" }));
    await waitFor(() => expect(lastToast()?.title).toBe("Employee archived"));
    const row = screen.getByText("Maria Santos").closest("tr")!;
    expect(within(row).getByText("Deactivated")).toBeInTheDocument();
    expect(within(row).getByText("Not enrolled — enroll")).toBeInTheDocument();
  });

  it("saves a role change and its password in ONE request", async () => {
    setup();
    patch.mockResolvedValue({ data: { ...juan, role: "OPERATOR", can_login: true } });
    await screen.findByText("Juan Dela Cruz");
    await userEvent.click(screen.getByRole("button", { name: "Edit Juan Dela Cruz" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.selectOptions(within(dialog).getByLabelText(/^Role/), "OPERATOR");
    await userEvent.type(within(dialog).getByLabelText(/password/i), "longenough1");
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch).toHaveBeenCalledWith(`/users/${juan.id}`, { role: "OPERATOR", password: "longenough1" });
  });

  it("requires a password before turning a staff member into a kiosk device account", async () => {
    setup();
    await screen.findByText("Juan Dela Cruz");
    await userEvent.click(screen.getByRole("button", { name: "Edit Juan Dela Cruz" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.selectOptions(within(dialog).getByLabelText(/^Role/), "KIOSK");
    expect(within(dialog).getByText(/can only run the attendance kiosk/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Save changes" }));
    expect(await within(dialog).findByText(/needs a password/)).toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
  });

  it("pages a long employee list", async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({ ...maria, id: `u-${i}`, full_name: `Person ${String(i).padStart(2, "0")}`, email: `p${i}@example.test` }));
    useAuthStore.setState({ user: admin });
    get.mockImplementation((url: string) => Promise.resolve({ data: url === "/users" ? many : [] }));
    render(
      <MemoryRouter>
        <Employees />
      </MemoryRouter>
    );
    expect(await screen.findByText("Person 00")).toBeInTheDocument();
    expect(screen.queryByText("Person 55")).not.toBeInTheDocument();
    expect(screen.getByText(/of/, { selector: "p" })).toHaveTextContent("Showing 1–50 of 60 employees");
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByText("Person 55")).toBeInTheDocument();
    expect(screen.queryByText("Person 00")).not.toBeInTheDocument();
  });
});
