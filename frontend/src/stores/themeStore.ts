import { create } from "zustand";

export type Theme = "dark" | "light";
const KEY = "admin-theme";

function read(): Theme {
  try {
    return localStorage.getItem(KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/** The admin screens' colour theme. Dark is the default (and what the kiosk and sign-in always use); light is opt-in and remembered. */
export const useThemeStore = create<{ theme: Theme; toggle: () => void }>((set, get) => ({
  theme: read(),
  toggle: () => {
    const next: Theme = get().theme === "dark" ? "light" : "dark";
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* private mode: the choice just lasts for this visit */
    }
    set({ theme: next });
  },
}));
