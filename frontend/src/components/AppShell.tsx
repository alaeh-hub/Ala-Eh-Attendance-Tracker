import { ReactNode, useEffect, useRef, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { motion } from "motion/react";
import { useIdle } from "../hooks/useIdle";
import { usePageChoreography } from "../hooks/usePageChoreography";
import { EASE_OUT, motionOK } from "../lib/motion";
import api from "../services/api";
import { useAuthStore } from "../stores/authStore";
import type { Role } from "../types";
import Icon, { IconName } from "./Icon";
import IdleScreen from "./IdleScreen";
import { Avatar, RoleBadge } from "./ui";
import { SpotlightNav } from "./fx/SpotlightNav";
import { UnderlineLink } from "./fx/UnderlineLink";
import { formatDate, formatTime, orgNow, useOrgStore } from "../utils/orgTime";

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

// Admins land on the portal dashboard, kiosk operators and kiosk device accounts on the kiosk, staff on their own records.
export function homeFor(role?: Role) {
  return role === "STAFF" ? "/records" : role === "OPERATOR" || role === "KIOSK" ? "/kiosk" : "/admin";
}

function Brand({ compact = false }: { compact?: boolean }) {
  const user = useAuthStore((s) => s.user);
  return (
    <Link to={homeFor(user?.role)} className="flex items-center gap-3 rounded-lg transition-opacity hover:opacity-90">
      <img src="/logo.png" alt="Ala Eh! Food Products" className="h-11 w-11 shrink-0 rounded-full" />
      {!compact && (
        <div className="leading-tight">
          <p className="font-display text-base font-bold tracking-tight text-white">
            Ala Eh<span className="text-brand-400">!</span>
          </p>
          <p className="text-[11px] font-medium text-neutral-500">{user?.role === "STAFF" ? "Attendance" : "Admin portal"}</p>
        </div>
      )}
    </Link>
  );
}

/** Scans waiting on an admin. Refreshed on navigation and every minute. */
function usePendingReview() {
  const user = useAuthStore((s) => s.user);
  const [pendingReview, setPendingReview] = useState(0);
  const location = useLocation();
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
  return pendingReview;
}

function TopNav() {
  const user = useAuthStore((s) => s.user);
  const pendingReview = usePendingReview();
  const items = NAV.filter((n) => user && n.roles.includes(user.role)).map((n) => ({
    to: n.to,
    end: n.end,
    icon: n.icon,
    label: n.label === "Records" && user?.role === "STAFF" ? "My attendance" : n.label,
    badge: n.to === "/admin/review" ? pendingReview : 0,
  }));
  return <SpotlightNav items={items} />;
}

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const user = useAuthStore((s) => s.user);
  const pendingReview = usePendingReview();
  const items = NAV.filter((n) => user && n.roles.includes(user.role));
  return (
    <nav className="flex flex-col gap-1">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          onClick={onNavigate}
          className={({ isActive }) =>
            `relative flex items-center gap-3 rounded-lg px-3.5 py-2.5 text-sm font-medium transition-colors active:bg-ink-700 ${
              isActive ? "bg-ink-750 text-white before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-brand-500" : "text-neutral-400 hover:bg-ink-800 hover:text-white"
            }`
          }
        >
          <Icon name={item.icon} className="h-[18px] w-[18px]" />
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
          className="mt-3 flex items-center gap-3 rounded-lg border border-ink-600 px-3.5 py-2.5 text-sm font-medium text-brand-400 transition-colors hover:bg-ink-800 active:bg-ink-750"
        >
          <Icon name="scan" className="h-[18px] w-[18px]" />
          Open kiosk
        </NavLink>
      )}
    </nav>
  );
}

function UserCard({ compact = false }: { compact?: boolean }) {
  const { user, logout } = useAuthStore();
  if (!user) return null;
  if (compact)
    return (
      <div className="flex items-center gap-2.5">
        <Avatar userId={user.id} name={user.full_name} hasPhoto={user.has_photo} />
        <div className="hidden min-w-0 leading-tight 2xl:block">
          <p className="max-w-[140px] truncate text-sm font-semibold text-white">{user.full_name}</p>
          <RoleBadge role={user.role} />
        </div>
        <button
          onClick={() => void logout()}
          className="rounded-lg p-2 text-neutral-500 transition-colors duration-200 hover:bg-red-500/10 hover:text-red-300 active:scale-[.92]"
          title="Log out"
          aria-label="Log out"
        >
          <Icon name="logout" className="h-[18px] w-[18px]" />
        </button>
      </div>
    );
  return (
    <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-3 transition-colors duration-200 hover:border-white/10">
      <div className="flex items-center gap-3">
        <Avatar userId={user.id} name={user.full_name} hasPhoto={user.has_photo} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-white">{user.full_name}</p>
          <RoleBadge role={user.role} />
        </div>
        <button
          onClick={() => void logout()}
          className="rounded-lg p-2 text-neutral-500 transition-colors duration-200 hover:bg-red-500/10 hover:text-red-300 active:scale-[.92]"
          title="Log out"
          aria-label="Log out"
        >
          <Icon name="logout" className="h-[18px] w-[18px]" />
        </button>
      </div>
    </div>
  );
}

/** Avatar button with the account's details, the date and time, the kiosk shortcut and sign-out in one popover. */
function AccountMenu() {
  const { user, logout } = useAuthStore();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  if (!user) return null;
  return (
    <div ref={wrap} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className="flex items-center gap-2 rounded-full p-1 pr-2 text-neutral-400 transition-colors hover:bg-ink-800 hover:text-white"
      >
        <Avatar userId={user.id} name={user.full_name} hasPhoto={user.has_photo} />
        <Icon name="chevron_down" className={`h-4 w-4 transition-transform duration-200 ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div role="menu" className="pop absolute right-0 top-full z-[var(--z-dropdown)] mt-3 w-72 animate-fade-in p-4">
          <div className="flex items-center gap-3">
            <Avatar userId={user.id} name={user.full_name} hasPhoto={user.has_photo} size="h-11 w-11" text="text-sm" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-white">{user.full_name}</p>
              <p className="truncate text-xs text-neutral-400">{user.email}</p>
              <div className="mt-1">
                <RoleBadge role={user.role} />
              </div>
            </div>
          </div>
          <div className="my-4 border-t border-ink-700 pt-4">
            <Clock />
          </div>
          <div className="flex flex-col gap-1">
            {user.role !== "STAFF" && (
              <Link role="menuitem" to="/kiosk" className="menu-item">
                <Icon name="scan" className="h-[18px] w-[18px]" /> Open kiosk
              </Link>
            )}
            <button role="menuitem" type="button" onClick={() => void logout()} className="menu-item hover:!text-red-300" title="Log out" aria-label="Log out">
              <Icon name="logout" className="h-[18px] w-[18px]" /> Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Clock({ compact = false }: { compact?: boolean }) {
  const [now, setNow] = useState(orgNow);
  useOrgStore((s) => s.timeZone); // re-render when the org timezone arrives
  useEffect(() => {
    const t = setInterval(() => setNow(orgNow()), 1000 * 15);
    return () => clearInterval(t);
  }, []);
  if (compact)
    return (
      <div className="hidden text-right text-xs leading-tight text-neutral-500 xl:block">
        <p className="font-semibold text-neutral-300">{formatDate(now, { weekday: "short", month: "short", day: "numeric" })}</p>
        <p className="tabular-nums">{formatTime(now.toISOString())}</p>
      </div>
    );
  return (
    <div className="px-1 text-xs text-neutral-500">
      <p className="font-semibold text-neutral-300">{formatDate(now, { weekday: "long", month: "long", day: "numeric" })}</p>
      <p>{formatTime(now.toISOString())}</p>
    </div>
  );
}

export default function AppShell({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const user = useAuthStore((s) => s.user);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);
  const mainRef = useRef<HTMLElement>(null);
  usePageChoreography(mainRef, location.pathname);
  const finishLeavingKiosk = useAuthStore((s) => s.finishLeavingKiosk);
  useEffect(() => finishLeavingKiosk(), [finishLeavingKiosk]);

  // The kiosk's whole job is to sit idle waiting for the next scan — a
  // screensaver popping up over the camera would break it. Every other
  // page is a normal admin screen, so it gets the idle privacy screen.
  const idle = useIdle(IDLE_TIMEOUT_MS);
  const showIdleScreen = idle && location.pathname !== "/kiosk";

  return (
    <div className="min-h-screen">
      {showIdleScreen && <IdleScreen />}
      {/* Desktop top bar: brand and spotlight nav on the left, the account menu on the right */}
      <header className="topbar hidden lg:block">
        <div className="mx-auto flex h-[68px] w-full max-w-[1440px] items-center gap-6 px-8">
          <Brand />
          <div className="flex min-w-0 flex-1 justify-start self-stretch pl-2">
            <TopNav />
          </div>
          <AccountMenu />
        </div>
      </header>

      {/* Mobile top bar */}
      <header className="topbar flex h-16 items-center justify-between px-4 lg:hidden">
        <Brand />
        <button className="rounded-xl p-2 text-neutral-300 transition-colors duration-200 hover:bg-white/10 active:scale-[.92]" onClick={() => setOpen(true)} aria-label="Open menu">
          <Icon name="menu" className="h-6 w-6" />
        </button>
      </header>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/70 animate-fade-in" onClick={() => setOpen(false)} />
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

      <motion.main
        ref={mainRef}
        key={location.pathname}
        initial={motionOK() ? { opacity: 0, y: 10 } : false}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.38, ease: EASE_OUT }}
        className="mx-auto w-full min-w-0 max-w-[1440px] overflow-x-clip px-4 py-6 sm:px-6 lg:px-8 lg:py-10"
      >
        {children}
      </motion.main>
    </div>
  );
}
