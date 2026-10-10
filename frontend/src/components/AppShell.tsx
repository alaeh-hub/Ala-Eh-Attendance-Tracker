import { ReactNode, useEffect, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { useIdle } from "../hooks/useIdle";
import api from "../services/api";
import { useAuthStore } from "../stores/authStore";
import type { Role } from "../types";
import Icon, { IconName } from "./Icon";
import IdleScreen from "./IdleScreen";
import { Avatar, RoleBadge } from "./ui";

const IDLE_TIMEOUT_MS = 60_000;

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  roles: Role[];
  end?: boolean;
}

export const NAV: NavItem[] = [
  { to: "/admin", label: "Dashboard", icon: "dashboard", roles: ["ADMIN", "OPERATOR"], end: true },
  { to: "/admin/reports", label: "Reports", icon: "clock", roles: ["ADMIN"] },
  { to: "/admin/employees", label: "Employees", icon: "users", roles: ["ADMIN"] },
  { to: "/admin/enroll", label: "Enroll", icon: "enroll", roles: ["ADMIN"] },
  { to: "/admin/departments", label: "Departments", icon: "building", roles: ["ADMIN"] },
  { to: "/admin/review", label: "Review", icon: "eye", roles: ["ADMIN"] },
  { to: "/records", label: "Records", icon: "records", roles: ["ADMIN", "OPERATOR", "STAFF"] },
];

// Admins land on the portal dashboard, kiosk operators on the kiosk, staff on their own records.
export function homeFor(role?: Role) {
  return role === "STAFF" ? "/records" : role === "OPERATOR" ? "/kiosk" : "/admin";
}

function Brand({ compact = false }: { compact?: boolean }) {
  const user = useAuthStore((s) => s.user);
  return (
    <Link to={homeFor(user?.role)} className="group flex items-center gap-3 rounded-xl transition-opacity hover:opacity-90">
      <img src="/logo.png" alt="Ala Eh! Food Products" className="h-11 w-11 shrink-0 rounded-full shadow-glow transition-transform duration-300 group-hover:scale-105" />
      {!compact && (
        <div className="leading-tight">
          <p className="text-[15px] font-extrabold tracking-tight text-white">
            Ala Eh<span className="text-brand-400">!</span>
          </p>
          <p className="text-[11px] font-medium uppercase tracking-[0.18em] text-neutral-500">{user?.role === "STAFF" ? "Attendance" : "Admin portal"}</p>
        </div>
      )}
    </Link>
  );
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const user = useAuthStore((s) => s.user);
  const [pendingReview, setPendingReview] = useState(0);
  const location = useLocation();
  // Badge for scans waiting on an admin. Refreshed on navigation and every minute.
  useEffect(() => {
    if (user?.role !== "ADMIN") return;
    const load = () =>
      api
        .get<{ pending_count: number }>("/review/snapshots", { params: { filter: "pending", limit: 1 } })
        .then((r) => setPendingReview(r.data.pending_count))
        .catch(() => undefined);
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [user?.role, location.pathname]);
  const items = NAV.filter((n) => user && n.roles.includes(user.role));
  return (
    <nav className="flex flex-col gap-1">
      {items.map((item, i) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          onClick={onNavigate}
          className={({ isActive }) =>
            `group relative flex animate-fade-up items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-semibold transition-all duration-200 active:scale-[.98] ${
              isActive ? "bg-brand-500 text-black shadow-[0_8px_24px_-10px_rgba(245,192,0,.7)]" : "text-neutral-400 hover:bg-white/[0.05] hover:text-white"
            }`
          }
          style={{ animationDelay: `${i * 40}ms` }}
        >
          <Icon name={item.icon} className="h-[18px] w-[18px] transition-transform duration-200 group-hover:scale-110" />
          {item.label === "Records" && user?.role === "STAFF" ? "My attendance" : item.label}
          {item.to === "/admin/review" && pendingReview > 0 && (
            <span className="ml-auto rounded-full bg-red-500 px-2 py-0.5 text-[11px] font-bold tabular-nums text-white">{pendingReview > 99 ? "99+" : pendingReview}</span>
          )}
        </NavLink>
      ))}
      {user && user.role !== "STAFF" && (
        <NavLink
          to="/kiosk"
          onClick={onNavigate}
          className="mt-3 flex items-center gap-3 rounded-xl border border-brand-500/30 px-3.5 py-2.5 text-sm font-semibold text-brand-400 transition-colors hover:bg-brand-500/10"
        >
          <Icon name="scan" className="h-[18px] w-[18px]" />
          Open kiosk
        </NavLink>
      )}
    </nav>
  );
}

function UserCard() {
  const { user, logout } = useAuthStore();
  if (!user) return null;
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3 transition-colors duration-200 hover:border-white/10">
      <div className="flex items-center gap-3">
        <Avatar userId={user.id} name={user.full_name} hasPhoto={user.has_photo} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-white">{user.full_name}</p>
          <RoleBadge role={user.role} />
        </div>
        <button
          onClick={logout}
          className="rounded-lg p-2 text-neutral-500 transition-all duration-200 hover:bg-red-500/10 hover:text-red-300 active:scale-[.92]"
          title="Log out"
          aria-label="Log out"
        >
          <Icon name="logout" className="h-[18px] w-[18px]" />
        </button>
      </div>
    </div>
  );
}

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000 * 15);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="px-1 text-xs text-neutral-500">
      <p className="font-semibold text-neutral-300">{now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</p>
      <p>{now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</p>
    </div>
  );
}

export default function AppShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);

  // The kiosk's whole job is to sit idle waiting for the next scan — a
  // screensaver popping up over the camera would break it. Every other
  // page is a normal admin screen, so it gets the idle privacy screen.
  const idle = useIdle(IDLE_TIMEOUT_MS);
  const showIdleScreen = idle && location.pathname !== "/kiosk";

  return (
    <div className="min-h-screen lg:pl-[272px]">
      {showIdleScreen && <IdleScreen />}
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[272px] flex-col gap-6 border-r border-white/[0.06] bg-ink-900/80 p-5 backdrop-blur-xl lg:flex">
        <Brand />
        <div className="h-px bg-gradient-to-r from-brand-500/40 via-white/10 to-transparent" />
        <NavLinks />
        <div className="mt-auto flex flex-col gap-4">
          <div className="h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
          <Clock />
          <UserCard />
        </div>
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-white/[0.06] bg-ink-900/85 px-4 backdrop-blur-xl lg:hidden">
        <Brand />
        <button className="rounded-xl p-2 text-neutral-300 transition-all duration-200 hover:bg-white/10 active:scale-[.92]" onClick={() => setOpen(true)} aria-label="Open menu">
          <Icon name="menu" className="h-6 w-6" />
        </button>
      </header>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-fade-in" onClick={() => setOpen(false)} />
          <div className="absolute inset-y-0 left-0 flex w-[280px] flex-col gap-6 border-r border-white/10 bg-ink-900 p-5 animate-slide-in">
            <div className="flex items-center justify-between">
              <Brand />
              <button
                className="group rounded-lg p-1.5 text-neutral-400 transition-colors hover:bg-white/10 hover:text-white"
                onClick={() => setOpen(false)}
                aria-label="Close menu"
              >
                <Icon name="close" className="h-5 w-5 transition-transform duration-200 group-hover:rotate-90" />
              </button>
            </div>
            <NavLinks onNavigate={() => setOpen(false)} />
            <div className="mt-auto">
              <UserCard />
            </div>
          </div>
        </div>
      )}

      <main key={location.pathname} className="mx-auto w-full min-w-0 max-w-7xl overflow-x-clip px-4 py-6 sm:px-6 lg:px-10 lg:py-10">
        {children}
      </main>
    </div>
  );
}
