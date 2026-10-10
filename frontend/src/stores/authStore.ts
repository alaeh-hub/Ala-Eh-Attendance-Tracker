import { create } from "zustand";
import type { User } from "../types";
import { unlockKiosk } from "../utils/kioskLock";

// NOTE: uses "zustand" — add it to package.json dependencies
// ("zustand": "^4.5.4"), or swap this for React Context if you'd
// rather not add the extra dependency.
const STORED_USER_KEY = "auth_user";

function loadStoredUser(): User | null {
  try {
    const raw = localStorage.getItem(STORED_USER_KEY);
    return raw ? (JSON.parse(raw) as User) : null;
  } catch {
    return null;
  }
}

interface AuthState {
  user: User | null;
  setSession: (user: User, accessToken: string, refreshToken: string) => void;
  setUser: (user: User) => void;
  logout: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  // Read from localStorage on init so a reload doesn't briefly (or
  // permanently) forget who's logged in before anything else runs.
  user: loadStoredUser(),
  setSession: (user, accessToken, refreshToken) => {
    localStorage.setItem("access_token", accessToken);
    localStorage.setItem("refresh_token", refreshToken);
    localStorage.setItem(STORED_USER_KEY, JSON.stringify(user));
    unlockKiosk(); // a fresh sign-in starts unlocked
    set({ user });
  },
  setUser: (user) => {
    localStorage.setItem(STORED_USER_KEY, JSON.stringify(user));
    set({ user });
  },
  logout: () => {
    localStorage.removeItem("access_token");
    localStorage.removeItem("refresh_token");
    localStorage.removeItem(STORED_USER_KEY);
    unlockKiosk();
    set({ user: null });
  },
}));
