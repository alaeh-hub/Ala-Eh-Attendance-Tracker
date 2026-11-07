/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      // Type scale lives in tokens.css as --fs-*/--lh-* pairs so phones get a smaller step
      // without touching every `text-*` class. `sm:` and up read the desktop values.
      fontSize: Object.fromEntries(
        ["xs", "sm", "base", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "6xl", "7xl"].map((k) => [k, [`var(--fs-${k})`, `var(--lh-${k})`]])
      ),
      fontFamily: {
        sans: ["var(--font-body)"],
        display: ["var(--font-display)"],
      },
      colors: {
        // Warm black surfaces; values live in src/tokens.css as channel triplets.
        ink: Object.fromEntries([950, 900, 850, 800, 750, 700, 600, 500].map((n) => [n, `rgb(var(--ch-ink-${n}) / <alpha-value>)`])),
        // Brand yellow, taken from the Ala Eh! logo
        brand: Object.fromEntries([50, 100, 200, 300, 400, 500, 600, 700, 800, 900].map((n) => [n, `rgb(var(--ch-brand-${n}) / <alpha-value>)`])),
        white: "rgb(var(--ch-white) / <alpha-value>)",
        black: "rgb(var(--ch-black) / <alpha-value>)",
      },
      // One corner radius for every surface: the card radius. Controls use rounded-lg (the control radius).
      borderRadius: { xl: "var(--radius-card)", "2xl": "var(--radius-card)", lg: "var(--radius-ctl)" },
      boxShadow: {
        // Kept as names so existing classes resolve; the redesign draws depth with hairlines, not glows.
        glow: "none",
        card: "none",
      },
      keyframes: {
        "fade-up": { from: { opacity: 0, transform: "translateY(8px)" }, to: { opacity: 1, transform: "none" } },
        "fade-in": { from: { opacity: 0 }, to: { opacity: 1 } },
        "scale-in": { from: { opacity: 0, transform: "scale(.94)" }, to: { opacity: 1, transform: "none" } },
        // The scan element fills its frame and carries the line at its top edge, so translating it sweeps the line.
        scan: { "0%": { transform: "translateY(10%)" }, "50%": { transform: "translateY(88%)" }, "100%": { transform: "translateY(10%)" } },
        "pulse-ring": { "0%": { transform: "scale(.92)", opacity: 0.7 }, "100%": { transform: "scale(1.3)", opacity: 0 } },
        "slide-in": { from: { opacity: 0, transform: "translateX(24px)" }, to: { opacity: 1, transform: "none" } },
        "draw-check": { from: { strokeDashoffset: 48 }, to: { strokeDashoffset: 0 } },
      },
      animation: {
        "fade-up": "fade-up .45s cubic-bezier(.2,.7,.2,1) both",
        "fade-in": "fade-in .3s ease both",
        "scale-in": "scale-in .35s cubic-bezier(.2,.7,.2,1) both",
        scan: "scan 2.4s ease-in-out infinite",
        "pulse-ring": "pulse-ring 1.6s cubic-bezier(.2,.7,.2,1) infinite",
        "slide-in": "slide-in .35s cubic-bezier(.2,.7,.2,1) both",
        "draw-check": "draw-check .5s .15s ease-out both",
      },
    },
  },
  plugins: [],
};
