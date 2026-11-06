import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { homeFor } from "../../components/AppShell";
import Icon from "../../components/Icon";
import { Spinner } from "../../components/ui";
import type { ScanClock } from "../../components/fx/AsciiImage";
import { ScanOverlay } from "../../components/fx/ScanOverlay";
import api, { SessionPayload, errorMessage } from "../../services/api";
import { useAuthStore } from "../../stores/authStore";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const clock = useRef<ScanClock>({ born: 0 }); // one timeline for the logo and the form
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
    <div className="ascii-page relative grid h-dvh place-items-center overflow-hidden px-4">

      <main className="relative z-[1] w-full max-w-[380px] animate-fade-in">
        <div className="relative z-[3]">
        <p className="ascii-rule text-sm text-neutral-400" aria-hidden="true">
          ┌─ sign-in ──────────────────────────────────────────
        </p>
        <div className="mt-4 flex items-center gap-3">
          <img src="/logo.png" alt="Ala Eh! Food Products" className="h-12 w-12 shrink-0 rounded-full" />
          <h1 className="font-display text-4xl font-bold tracking-tight text-white">
            Sign in<span className="ascii-cursor text-brand-400" aria-hidden="true">_</span>
          </h1>
        </div>
        <p className="mt-2 text-sm text-neutral-400">Secure access to Ala Eh! attendance.</p>

        <form onSubmit={handleSubmit} className="mt-8 space-y-6">
          <label className="block">
            <span className="label">Email</span>
            <input
              className="ascii-input"
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
                className="ascii-input pr-11"
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
                className={`absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 transition-colors ${showPassword ? "text-brand-400" : "text-neutral-400 hover:text-neutral-100"}`}
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                <Icon name="eye" className="h-4 w-4" />
              </button>
            </div>
          </label>

          {error && (
            <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm text-red-300 animate-fade-in">
              <Icon name="alert" className="mt-0.5 h-4 w-4 shrink-0" />
              {error}
            </div>
          )}

          <button type="submit" disabled={loading} className="btn-primary w-full py-3.5 text-[15px]">
            {loading ? <Spinner /> : <Icon name="login" className="h-4 w-4" />}
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>
        </div>
      </main>
      {/* No card: on first load the whole page is ASCII, then one scan line turns it into the real sign-in. */}
      <ScanOverlay clock={clock.current} tone="--color-paper" className="fixed inset-0" />
    </div>
  );
}
