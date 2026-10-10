import { create } from "zustand";

export type ToastTone = "success" | "error" | "info";
export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  message?: string;
}

interface ToastState {
  toasts: Toast[];
  push: (tone: ToastTone, title: string, message?: string) => void;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  push: (tone, title, message) => {
    const id = nextId++;
    set({ toasts: [...get().toasts, { id, tone, title, message }].slice(-4) });
    setTimeout(() => get().dismiss(id), tone === "error" ? 6000 : 3800);
  },
  dismiss: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

export const toast = {
  success: (title: string, message?: string) => useToastStore.getState().push("success", title, message),
  error: (title: string, message?: string) => useToastStore.getState().push("error", title, message),
  info: (title: string, message?: string) => useToastStore.getState().push("info", title, message),
};
