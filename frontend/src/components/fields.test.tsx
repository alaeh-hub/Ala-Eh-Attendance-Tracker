import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it } from "vitest";
import { Select } from "./fields";

const DEPTS = ["Human Resources", "Kitchen", "Packaging", "Finance", "Quality Control", "Maintenance", "Logistics", "Security", "Administration"];

function Harness({ options }: { options: string[] }) {
  const [value, setValue] = useState("");
  return (
    <>
      <Select value={value} onChange={(e) => setValue(e.target.value)} aria-label="Department">
        <option value="">All departments</option>
        {options.map((d) => (
          <option key={d}>{d}</option>
        ))}
      </Select>
      <output data-testid="value">{value}</output>
    </>
  );
}

// The component keeps a hidden native <select> with the same label, so pick the visible trigger button.
// Only the popover's options, not the hidden native <select>'s.
const shown = () => within(screen.getByRole("listbox")).getAllByRole("option");
const trigger = () => screen.getAllByRole("combobox", { name: "Department" }).find((el) => el.tagName === "BUTTON") as HTMLElement;

describe("Select", () => {
  // jsdom has no scrollIntoView; the list calls it to keep the active option on screen.
  beforeAll(() => {
    Element.prototype.scrollIntoView = () => undefined;
  });

  it("has no search box for a short list", async () => {
    render(<Harness options={DEPTS.slice(0, 3)} />);
    await userEvent.click(trigger());
    expect(screen.queryByRole("combobox", { name: "Search options" })).not.toBeInTheDocument();
    expect(shown()).toHaveLength(4);
  });

  it("gets a smart search box once the list is long", async () => {
    render(<Harness options={DEPTS} />);
    await userEvent.click(trigger());
    const search = await screen.findByRole("combobox", { name: "Search options" });
    await userEvent.type(search, "qualty contrl");
    // two typos still land on "Quality Control"
    const options = shown();
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Quality Control");
  });

  it("picks the best match with Enter and closes", async () => {
    render(<Harness options={DEPTS} />);
    await userEvent.click(trigger());
    await userEvent.type(await screen.findByRole("combobox", { name: "Search options" }), "kitchn{Enter}");
    expect(screen.getByTestId("value")).toHaveTextContent("Kitchen");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("says so when nothing matches, and Escape clears before it closes", async () => {
    render(<Harness options={DEPTS} />);
    await userEvent.click(trigger());
    const search = await screen.findByRole("combobox", { name: "Search options" });
    await userEvent.type(search, "zzzz");
    expect(screen.getByText("No matches")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(search).toHaveValue("");
    expect(shown().length).toBe(DEPTS.length + 1);
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
