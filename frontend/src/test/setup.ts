import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// Routes are lazy chunks: under a parallel full run the first findBy/waitFor can need more than the 1s default.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
  localStorage.clear();
});

// jsdom has no matchMedia; page-mascot calls it unguarded on mount.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

// jsdom has no ResizeObserver; recharts' ResponsiveContainer constructs one as soon as a chart mounts (the dashboard).
// Whether that happens during a test depends on when the lazy dashboard chunk arrives, so without this a slower
// machine (CI) fails the run with an unhandled error even though every test passes. Nothing here has a layout, so
// the observer never has anything to report.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

// jsdom has no object URLs; the review page and avatars create them for blobs.
if (!URL.createObjectURL) {
  URL.createObjectURL = () => "blob:test";
  URL.revokeObjectURL = () => undefined;
}
