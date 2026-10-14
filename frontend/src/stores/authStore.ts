import { create } from "zustand";
import { clearPhotoCache } from "../components/ui";
import { EXPIRED_EVENT, KIOSK_LOCKED_EVENT, SESSION_EVENT } from "../services/authEvents";
import api, {
  SessionPayload,
  hasRefreshCookie,
  isAuthFailure,
  refreshSession,
  setAccessToken,
} from "../services/api";
import type { User } from "../types";

/**
 * Session state. Nothing secret is persisted: the access token lives in memory
 * (services/api.ts) and the refresh token is an httpOnly cookie. On load the
 * app calls restore(), which trades the cookie for a fresh access token.
 *
 * `kioskLocked` comes from the server: a kiosk-locked session can only reach
 * the kiosk, and only the server can lift the lock (POST /auth/kiosk/unlock).
 */
export type AuthStatus = "loading" | "offline" | "ready";

interface AuthState {
  user: User | null;
  kioskLocked: boolean;
  /** True from a successful unlock until the admin portal is showing: the kiosk page must not re-lock on its way out. */
  leavingKiosk: boolean;
  /** Called by the admin shell once it is on screen. */
  finishLeavingKiosk: () => void;
  /** "loading" until the first restore() settles; "offline" when the server couldn't be reached. */
  status: AuthStatus;
  setSession: (session: SessionPayload) => void;
  setUser: (user: User) => void;
  /** Forget the session locally (no server call). */
  clearSession: () => void;
  /** Revoke the session on the server, then forget it locally. */
  logout: () => Promise<void>;
  /** Restore a session from the refresh cookie (app start). */
  restore: () => Promise<void>;
  /** Lock this session into the kiosk (server-enforced). */
  lockKiosk: () => Promise<void>;
  /** Leave the kiosk; rejects with the axios error (403 WRONG_PASSWORD, 429...). */
  unlockKiosk: (password: string) => Promise<void>;
}

// Older builds kept tokens in localStorage. Remove them so they don't linger.
const LEGACY_KEYS = ["access_token", "refresh_token", "auth_user"];
function clearLegacyStorage() {
  try {
    LEGACY_KEYS.forEach((k) => localStorage.removeItem(k));
    sessionStorage.removeItem("kiosk_locked");
  } catch {
    /* storage unavailable */
  }
}
clearLegacyStorage();

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  kioskLocked: false,
  leavingKiosk: false,
  status: "loading",

  finishLeavingKiosk: () => set({ leavingKiosk: false }),

  setSession: (session) => {
    setAccessToken(session.access_token);
    set({ user: session.user, kioskLocked: !!session.kiosk_locked, status: "ready" });
  },

  setUser: (user) => set({ user }),

  clearSession: () => {
    setAccessToken(null);
    clearPhotoCache();
    clearLegacyStorage();
    set({ user: null, kioskLocked: false, leavingKiosk: false, status: "ready" });
  },

  logout: async () => {
    try {
      await api.post("/auth/logout");
    } catch {
      /* the server forgets the session on its own; never block signing out */
    }
    get().clearSession();
  },

  restore: async () => {
    if (!hasRefreshCookie()) {
      set({ status: "ready" });
      return;
    }
    try {
      get().setSession(await refreshSession());
    } catch (err) {
      if (isAuthFailure(err)) get().clearSession();
      // Network error / 5xx: we can't tell whether a session exists. Don't show
      // the sign-in page (a kiosk would be stuck there); App retries instead.
      else set({ status: "offline" });
    }
  },

  lockKiosk: async () => {
    const { data } = await api.post<SessionPayload>("/auth/kiosk/lock");
    set({ leavingKiosk: false });
    get().setSession(data);
  },

  unlockKiosk: async (password) => {
    const { data } = await api.post<SessionPayload>("/auth/kiosk/unlock", { password });
    set({ leavingKiosk: true });
    get().setSession(data);
  },
}));

// Keep the store in step with what the API layer learns on its own.
if (typeof window !== "undefined") {
  window.addEventListener(SESSION_EVENT, (e) => {
    const s = (e as CustomEvent<SessionPayload>).detail;
    if (s?.user) useAuthStore.setState({ user: s.user, kioskLocked: !!s.kiosk_locked });
  });
  window.addEventListener(EXPIRED_EVENT, () => {
    if (useAuthStore.getState().user) useAuthStore.getState().clearSession();
  });
  window.addEventListener(KIOSK_LOCKED_EVENT, () => {
    if (useAuthStore.getState().user) useAuthStore.setState({ kioskLocked: true });
  });
}
