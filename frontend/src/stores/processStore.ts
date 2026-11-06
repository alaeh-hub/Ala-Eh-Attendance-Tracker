import { create } from "zustand";

/**
 * Work the user is waiting on (a save, a delete, an export). The API layer starts an entry when such a request leaves and
 * ends it when it settles; <ProcessDialog> shows a dialog if the work is still running after a short delay.
 */
interface ProcessState {
  items: { id: number; label: string }[];
  start: (label: string) => number;
  end: (id: number | undefined) => void;
}

let nextId = 1;

export const useProcessStore = create<ProcessState>((set) => ({
  items: [],
  start: (label) => {
    const id = nextId++;
    set((s) => ({ items: [...s.items, { id, label }] }));
    return id;
  },
  end: (id) => {
    if (id === undefined) return;
    set((s) => ({ items: s.items.filter((i) => i.id !== id) }));
  },
}));
