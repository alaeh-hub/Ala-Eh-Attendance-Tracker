import { render } from "@testing-library/react";
import { ResponsiveContainer } from "recharts";
import { describe, expect, it } from "vitest";

// jsdom lacks several browser APIs the app relies on; src/test/setup.ts fills them in. These tests keep it honest,
// because the failure they guard against is timing-dependent: the lazily loaded dashboard mounts its charts whenever
// its chunk arrives, which on a slower machine (CI) can be after the test that rendered it has finished.
describe("test environment", () => {
  it("has a ResizeObserver, which recharts constructs the moment a chart mounts", () => {
    expect(typeof ResizeObserver).toBe("function");
    const observer = new ResizeObserver(() => undefined);
    expect(() => {
      observer.observe(document.body);
      observer.unobserve(document.body);
      observer.disconnect();
    }).not.toThrow();
  });

  it("mounts a recharts ResponsiveContainer without an unhandled error", () => {
    expect(() =>
      render(
        <ResponsiveContainer width="100%" height={120}>
          <div />
        </ResponsiveContainer>,
      ),
    ).not.toThrow();
  });
});
