import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Polling: bind-mounted Windows files don't emit change events inside the container.
  server: { port: 5173, watch: { usePolling: true, interval: 300 } },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    restoreMocks: true,
  },
});
