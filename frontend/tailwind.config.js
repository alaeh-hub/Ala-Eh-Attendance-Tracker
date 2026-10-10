/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', "ui-sans-serif", "system-ui", "Segoe UI", "sans-serif"],
      },
      colors: {
        // Black surfaces
        ink: {
          950: "#070707",
          900: "#0c0c0c",
          850: "#111111",
          800: "#161616",
          750: "#1c1c1c",
          700: "#232323",
          600: "#2e2e2e",
          500: "#3d3d3d",
        },
        // Brand yellow, taken from the Ala Eh! logo
        brand: {
          50: "#fffbea",
          100: "#fff3c4",
          200: "#ffe88a",
          300: "#ffdb4d",
          400: "#fdd023",
          500: "#f5c000",
          600: "#d4a000",
          700: "#a77a00",
          800: "#7a5900",
          900: "#4d3800",
        },
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(245,192,0,.25), 0 8px 40px -8px rgba(245,192,0,.35)",
        card: "0 1px 0 0 rgba(255,255,255,.04) inset, 0 10px 30px -12px rgba(0,0,0,.8)",
      },
      keyframes: {
        "fade-up": { from: { opacity: 0, transform: "translateY(8px)" }, to: { opacity: 1, transform: "none" } },
        "fade-in": { from: { opacity: 0 }, to: { opacity: 1 } },
        "scale-in": { from: { opacity: 0, transform: "scale(.94)" }, to: { opacity: 1, transform: "none" } },
        scan: { "0%": { top: "10%" }, "50%": { top: "88%" }, "100%": { top: "10%" } },
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
