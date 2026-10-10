import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { homeFor } from "../../components/AppShell";
import Icon from "../../components/Icon";
import { Spinner } from "../../components/ui";
import api, { errorMessage } from "../../services/api";
import { useAuthStore } from "../../stores/authStore";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const user = useAuthStore((s) => s.user);
  const setSession = useAuthStore((s) => s.setSession);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (user) navigate((location.state as any)?.from || homeFor(user.role), { replace: true });
  }, [user, navigate, location.state]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await api.post("/auth/login", { email, password });
      setSession(res.data.user, res.data.access_token, res.data.refresh_token);
    } catch (err) {
      setError(errorMessage(err, "Couldn't sign you in. Check your email and password."));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-10">
      {/* Ambient glow */}
      <div className="pointer-events-none absolute left-1/2 top-1/2 h-[640px] w-[640px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand-500/10 blur-[120px]" />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(255,255,255,.025)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.025)_1px,transparent_1px)] bg-[size:48px_48px] [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_75%)]" />

      <div className="relative w-full max-w-[420px] animate-scale-in">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="relative mb-5">
            <span className="absolute inset-0 rounded-full bg-brand-500/30 blur-2xl" />
            <img src="/logo.png" alt="Ala Eh! Food Products" className="relative h-28 w-28 rounded-full shadow-glow" />
          </div>
          <h1 className="text-3xl font-extrabold tracking-tight text-white">
            Welcome back<span className="text-brand-400">.</span>
          </h1>
          <p className="mt-2 text-sm text-neutral-400">Sign in to the Ala Eh! attendance system</p>
        </div>

        <form onSubmit={handleSubmit} className="card space-y-4 border-white/10 p-7">
          <label className="block">
            <span className="label">Email</span>
            <input className="input" type="email" autoComplete="email" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
          </label>

          <label className="block">
            <span className="label">Password</span>
            <div className="relative">
              <input
                className="input pr-11"
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
                className={`absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 transition-colors ${showPassword ? "text-brand-400" : "text-neutral-500 hover:text-neutral-200"}`}
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

          <button type="submit" disabled={loading} className="btn-primary w-full py-3 text-[15px]">
            {loading ? <Spinner /> : <Icon name="login" className="h-4 w-4" />}
            {loading ? "Signing in..." : "Sign in"}
          </button>
        </form>

        <p className="mt-6 flex items-center justify-center gap-2 text-xs text-neutral-500">
          <Icon name="shield" className="h-3.5 w-3.5" /> Accounts are created by your administrator.
        </p>
      </div>
    </div>
  );
}
