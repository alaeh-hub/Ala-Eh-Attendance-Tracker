import "@testing-library/jest-dom/vitest";
import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

// Routes are lazy chunks: under a parallel full run the first findBy/waitFor can need more than the 1s default.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  cleanup();
  localStorage.clear();
});

// jsdom has no object URLs; the review page and avatars create them for blobs.
if (!URL.createObjectURL) {
  URL.createObjectURL = () => "blob:test";
  URL.revokeObjectURL = () => undefined;
}
