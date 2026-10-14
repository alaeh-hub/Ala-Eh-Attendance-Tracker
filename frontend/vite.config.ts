import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const truthy = (value: string | undefined) => /^(1|true|yes|on)$/i.test((value ?? "").trim());

export default defineConfig(({ mode }) => {
  // "" prefix: also read non-VITE_ variables (they stay out of the bundle;
  // only VITE_* reach import.meta.env).
  const env = loadEnv(mode, process.cwd(), "");

  // The dev server proxies the API and Socket.IO so the app, the API and
  // the refresh cookie all share one origin - exactly like production,
  // where Caddy does the routing. Override the target when the backend is
  // elsewhere (docker-compose.dev.yml sets http://backend:5000).
  const proxyTarget = env.VITE_DEV_PROXY_TARGET || "http://localhost:5000";

  // File-change polling is only needed for bind mounts that don't deliver
  // change events (Docker Desktop on Windows/macOS). It burns CPU, so it is
  // opt-in: VITE_USE_POLLING=true.
  const usePolling = truthy(env.VITE_USE_POLLING);

  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      watch: usePolling ? { usePolling: true, interval: 300 } : undefined,
      proxy: {
        "/api": {
          target: proxyTarget,
          changeOrigin: false,
          // X-Forwarded-For/-Proto, so the backend (TRUST_PROXY_HOPS=1)
          // rate-limits per real client instead of per proxy.
          xfwd: true,
        },
        "/socket.io": {
          target: proxyTarget,
          ws: true,
          changeOrigin: false,
          xfwd: true,
        },
      },
    },
    preview: {
      port: 4173,
      strictPort: true,
      proxy: {
        "/api": { target: proxyTarget, xfwd: true },
        "/socket.io": { target: proxyTarget, ws: true, xfwd: true },
      },
    },
    build: {
      // Kiosk tablets and admin PCs run current Chromium/Edge/Safari.
      target: "es2020",
      sourcemap: false,
    },
    test: {
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      css: false,
      restoreMocks: true,
    },
  };
});
