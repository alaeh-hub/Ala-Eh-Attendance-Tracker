import { Suspense, lazy, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { homeFor } from "../../components/AppShell";
import Icon from "../../components/Icon";
import { Spinner } from "../../components/ui";
import api, { SessionPayload, errorMessage } from "../../services/api";
import { useAuthStore } from "../../stores/authStore";

// three.js is heavy and only used here, so keep it out of the main bundle.
const FaceScan3D = lazy(() => import("./FaceScan3D"));

const HIGHLIGHTS = [
  "Face-verified time in and time out",
  "Shift-aware attendance and reports",
  "One kiosk, every employee",
];

/** Decorative face-scan frame: corner brackets, a sweeping scan line and a stylised face. */
function ScanGraphic() {
  return (
    <div className="relative mx-auto aspect-[4/5] w-full max-w-[280px]" aria-hidden="true">
      <span className="absolute inset-6 rounded-[40%] bg-brand-500/10 blur-3xl" />
      <svg viewBox="0 0 200 250" className="relative h-full w-full text-brand-400" fill="none" stroke="currentColor">
        {/* corner brackets */}
        <g strokeWidth="3" strokeLinecap="round">
          <path d="M8 44V12a4 4 0 0 1 4-4h32" />
          <path d="M156 8h32a4 4 0 0 1 4 4v32" />
          <path d="M192 206v32a4 4 0 0 1-4 4h-32" />
          <path d="M44 242H12a4 4 0 0 1-4-4v-32" />
        </g>
        {/* face */}
        <g strokeWidth="1.5" opacity=".55">
          <ellipse cx="100" cy="116" rx="46" ry="60" />
          <path d="M80 104h.01M120 104h.01" strokeWidth="6" strokeLinecap="round" />
          <path d="M100 112v22h-6" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M84 150q16 12 32 0" strokeLinecap="round" />
          <path d="M52 214q0-30 48-30t48 30" />
        </g>
        {/* landmark dots */}
        <g fill="currentColor" stroke="none" opacity=".8">
          {[[62, 90], [138, 90], [100, 70], [70, 140], [130, 140], [100, 172]].map(([x, y]) => (
            <circle key={`${x}-${y}`} cx={x} cy={y} r="2" />
          ))}
        </g>
      </svg>
      <div className="absolute inset-x-4 animate-scan">
        <div className="h-px bg-gradient-to-r from-transparent via-brand-400 to-transparent shadow-[0_0_18px_2px_rgba(245,192,0,.55)]" />
      </div>
    </div>
  );
}

/** True at the breakpoint where the brand panel is shown (Tailwind `lg`). */
function useBrandPanelVisible() {
  const query = "(min-width: 1024px)";
  const [visible, setVisible] = useState(() => typeof window.matchMedia === "function" && window.matchMedia(query).matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const onChange = () => setVisible(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return visible;
}

export default function Login() {
  const brandPanelVisible = useBrandPanelVisible();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const user = useAuthStore((s) => s.user);
  const kioskLocked = useAuthStore((s) => s.kioskLocked);
  const setSession = useAuthStore((s) => s.setSession);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!user) return;
    // A kiosk-locked session (a KIOSK device account) only ever goes to the kiosk.
    const target = kioskLocked ? "/kiosk" : (location.state as any)?.from || homeFor(user.role);
    navigate(target, { replace: true });
  }, [user, kioskLocked, navigate, location.state]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await api.post<SessionPayload>("/auth/login", { email, password });
      setSession(res.data);
    } catch (err) {
      setError(errorMessage(err, "Couldn't sign you in. Check your email and password."));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]">
      {/* Brand panel */}
      <aside className="relative hidden overflow-hidden border-r border-white/[0.06] bg-ink-900 lg:flex lg:flex-col lg:justify-between lg:p-12">
        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(255,255,255,.03)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.03)_1px,transparent_1px)] bg-[size:40px_40px] [mask-image:radial-gradient(ellipse_at_center,black_20%,transparent_75%)]" />
        <div className="pointer-events-none absolute -left-32 -top-32 h-96 w-96 rounded-full bg-brand-500/10 blur-[100px]" />

        <div className="relative flex items-center gap-3">
          <img src="/logo.png" alt="Ala Eh! Food Products" className="h-11 w-11 rounded-full shadow-glow" />
          <span className="text-sm font-bold tracking-wide text-white">Ala Eh! Food Products</span>
        </div>

        <div className="relative my-8 min-h-[320px] flex-1 animate-fade-up">
          {brandPanelVisible && (
            <Suspense fallback={<ScanGraphic />}>
              <FaceScan3D fallback={<ScanGraphic />} />
            </Suspense>
          )}
        </div>

        <div className="relative">
          <h2 className="max-w-sm text-2xl font-extrabold leading-snug tracking-tight text-white">
            Attendance that knows <span className="text-brand-400">who showed up.</span>
          </h2>
          <ul className="mt-5 space-y-2.5">
            {HIGHLIGHTS.map((h) => (
              <li key={h} className="flex items-center gap-2.5 text-sm text-neutral-400">
                <Icon name="shield" className="h-4 w-4 shrink-0 text-brand-500" />
                {h}
              </li>
            ))}
          </ul>
        </div>
      </aside>

      {/* Form panel */}
      <main className="relative flex items-center justify-center px-6 py-12 sm:px-10">
        <div className="pointer-events-none absolute right-0 top-0 h-72 w-72 rounded-full bg-brand-500/[0.06] blur-[100px] lg:hidden" />

        <div className="relative w-full max-w-[380px] animate-fade-up">
          <div className="mb-10 flex items-center gap-3 lg:hidden">
            <img src="/logo.png" alt="Ala Eh! Food Products" className="h-12 w-12 rounded-full shadow-glow" />
            <span className="text-sm font-bold tracking-wide text-white">Ala Eh! Food Products</span>
          </div>

          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-400">Staff portal</p>
          <h1 className="mt-3 text-4xl font-extrabold tracking-tight text-white">Sign in</h1>
          <p className="mt-2 text-sm text-neutral-400">Sign in to the Ala Eh! attendance system</p>

          <form onSubmit={handleSubmit} className="mt-9 space-y-6">
            <label className="block">
              <span className="label">Email</span>
              <input
                className="w-full border-0 border-b border-white/15 bg-transparent px-0 py-2.5 text-base text-white outline-none transition-colors placeholder:text-neutral-600 focus:border-brand-500 focus:ring-0"
                type="email"
                autoComplete="email"
                autoFocus
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@company.com"
              />
            </label>

            <label className="block">
              <span className="label">Password</span>
              <div className="relative">
                <input
                  className="w-full border-0 border-b border-white/15 bg-transparent px-0 py-2.5 pr-10 text-base text-white outline-none transition-colors placeholder:text-neutral-600 focus:border-brand-500 focus:ring-0"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className={`absolute right-0 top-1/2 -translate-y-1/2 rounded-lg p-1.5 transition-colors ${showPassword ? "text-brand-400" : "text-neutral-500 hover:text-neutral-200"}`}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  <Icon name="eye" className="h-4 w-4" />
                </button>
              </div>
            </label>

            {error && (
              <div role="alert" className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-300 animate-fade-in">
                <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
                {error}
              </div>
            )}

            <button type="submit" disabled={loading} className="btn-primary w-full rounded-full py-3.5 text-[15px]">
              {loading ? <Spinner /> : <Icon name="login" className="h-4 w-4" />}
              {loading ? "Signing in..." : "Sign in"}
            </button>
          </form>

          <p className="mt-8 flex items-center gap-2 text-xs text-neutral-500">
            <Icon name="shield" className="h-3.5 w-3.5" /> Accounts are created by your administrator.
          </p>
        </div>
      </main>
    </div>
  );
}
