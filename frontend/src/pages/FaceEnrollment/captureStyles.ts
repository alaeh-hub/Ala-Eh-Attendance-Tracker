/** Class strings shared by the capture screen's pieces: the same glass styling as the kiosk's controls. */

export const glass = "border border-white/10 bg-black/55";
export const hudBtn = `${glass} flex h-12 min-w-12 items-center justify-center gap-2 rounded-full px-4 text-base font-semibold text-white transition-colors hover:bg-black/75 active:scale-95`;
export const dockBtn =
  "flex h-14 min-w-14 items-center justify-center gap-2 rounded-2xl px-4 text-base font-bold transition-colors active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100 sm:h-16 sm:text-lg";
export const ghostBtn = `${dockBtn} border border-white/15 bg-white/[0.06] text-neutral-100 hover:bg-white/10`;

export const noticeStyle = {
  success: { box: "border-emerald-400/50", badge: "bg-emerald-500 text-black", icon: "check" as const },
  warn: { box: "border-orange-400/50", badge: "bg-orange-500 text-black", icon: "alert" as const },
  error: { box: "border-red-500/50", badge: "bg-red-500 text-white", icon: "x_circle" as const },
};
