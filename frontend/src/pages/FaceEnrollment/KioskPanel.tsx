export default /** A centred card over a dimmed, blurred camera: the enrollment version of the kiosk's result overlays. */
function KioskPanel({ children, tone }: { children: React.ReactNode; tone: "success" | "info" | "warn" | "error" }) {
  const border = { success: "border-emerald-400/40", info: "border-brand-500/40", warn: "border-orange-400/40", error: "border-red-500/40" }[tone];
  return (
    <div className="absolute inset-0 z-10 flex overflow-y-auto bg-black/75 p-4 animate-fade-in">
      <div className={`m-auto w-full max-w-md rounded-3xl border bg-black/60 p-5 text-center animate-scale-in sm:p-8 ${border}`}>{children}</div>
    </div>
  );
}
