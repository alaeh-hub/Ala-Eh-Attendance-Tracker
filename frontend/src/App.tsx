import { Suspense, lazy, useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import AppShell, { homeFor } from "./components/AppShell";
import Icon from "./components/Icon";
import KioskShell from "./components/KioskShell";
import Toaster from "./components/Toaster";
import Login from "./pages/Login/Login";
import { Spinner } from "./components/ui";
import api from "./services/api";
import { EXPIRED_EVENT } from "./services/authEvents";
import { useAuthStore } from "./stores/authStore";
import { toast } from "./stores/toastStore";
import type { Role } from "./types";
import { OrgMeta, useOrgStore } from "./utils/orgTime";

const AttendanceKiosk = lazy(() => import("./pages/Attendance/AttendanceKiosk"));
const Dashboard = lazy(() => import("./pages/Dashboard/Dashboard"));
const Reports = lazy(() => import("./pages/Reports/Reports"));
const Employees = lazy(() => import("./pages/Employees/Employees"));
const Departments = lazy(() => import("./pages/Departments/Departments"));
const FaceEnrollment = lazy(() => import("./pages/FaceEnrollment/FaceEnrollment"));
const Records = lazy(() => import("./pages/Records/Records"));
const Review = lazy(() => import("./pages/Review/Review"));

const META_REFRESH_MS = 60 * 60 * 1000;
const OFFLINE_RETRY_MS = 5000;

export const KIOSK_ROLES: Role[] = ["ADMIN", "OPERATOR", "KIOSK"];

function RequireAuth({ roles, kiosk, children }: { roles?: Role[]; kiosk?: boolean; children: JSX.Element }) {
  const user = useAuthStore((s) => s.user);
  const kioskLocked = useAuthStore((s) => s.kioskLocked);
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  // A kiosk-locked session (server-enforced) can only be on the kiosk.
  if (kioskLocked && !kiosk) return <Navigate to="/kiosk" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to={homeFor(user.role)} replace />;
  const Shell = kiosk ? KioskShell : AppShell;
  return (
    <Shell>
      <Suspense fallback={<div className="flex justify-center py-24 text-brand-400"><Spinner className="h-7 w-7" /></div>}>{children}</Suspense>
    </Shell>
  );
}

function HomeRedirect() {
  const user = useAuthStore((s) => s.user);
  const kioskLocked = useAuthStore((s) => s.kioskLocked);
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Navigate to={kioskLocked ? "/kiosk" : homeFor(user.role)} replace />;
}

/** Shown while the session is being restored, so the sign-in page doesn't flash. */
function BootScreen({ offline, onRetry }: { offline: boolean; onRetry: () => void }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-5 px-4 text-center" role="status" aria-live="polite">
      <img src="/logo.png" alt="Ala Eh! Food Products" className="h-20 w-20 rounded-full shadow-glow" />
      {offline ? (
        <>
          <p className="flex items-center gap-2 text-sm text-neutral-300">
            <Icon name="alert" className="h-4 w-4 text-orange-300" /> Can't reach the server. Retrying…
          </p>
          <button className="btn-ghost" onClick={onRetry}>
            <Icon name="refresh" className="h-4 w-4" /> Try now
          </button>
        </>
      ) : (
        <p className="flex items-center gap-2 text-sm text-neutral-400">
          <Spinner /> Loading…
        </p>
      )}
    </div>
  );
}

/** Loads the organisation's timezone / server clock after sign-in, then hourly. */
function useOrgMeta(signedIn: boolean) {
  const setMeta = useOrgStore((s) => s.setMeta);
  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    const load = () =>
      api
        .get<OrgMeta>("/meta")
        .then((r) => {
          if (!cancelled && r?.data?.timezone) setMeta(r.data);
        })
        .catch(() => undefined); // keep the last known meta (or the browser timezone)
    load();
    const t = setInterval(load, META_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [signedIn, setMeta]);
}

export default function App() {
  const status = useAuthStore((s) => s.status);
  const user = useAuthStore((s) => s.user);
  const restore = useAuthStore((s) => s.restore);

  // Restore the session from the refresh cookie on load; while the server is
  // unreachable keep retrying instead of showing the sign-in page.
  useEffect(() => {
    if (status === "loading") restore();
    if (status !== "offline") return;
    const t = setTimeout(restore, OFFLINE_RETRY_MS);
    return () => clearTimeout(t);
  }, [status, restore]);

  useEffect(() => {
    const onExpired = () => toast.info("Session ended", "Please sign in again.");
    window.addEventListener(EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(EXPIRED_EVENT, onExpired);
  }, []);

  useOrgMeta(!!user?.id);

  if (status !== "ready") return <BootScreen offline={status === "offline"} onRetry={restore} />;

  return (
    <>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<HomeRedirect />} />
        {/* Kiosk: full-screen, no admin menu. Entering it locks the session on the server. */}
        <Route path="/kiosk" element={<RequireAuth kiosk roles={KIOSK_ROLES}><AttendanceKiosk /></RequireAuth>} />
        {/* Admin portal: everything for managing the system lives under /admin. */}
        <Route path="/admin" element={<RequireAuth roles={["ADMIN", "OPERATOR"]}><Dashboard /></RequireAuth>} />
        <Route path="/admin/reports" element={<RequireAuth roles={["ADMIN"]}><Reports /></RequireAuth>} />
        <Route path="/admin/employees" element={<RequireAuth roles={["ADMIN"]}><Employees /></RequireAuth>} />
        <Route path="/admin/enroll" element={<RequireAuth roles={["ADMIN"]}><FaceEnrollment /></RequireAuth>} />
        <Route path="/admin/departments" element={<RequireAuth roles={["ADMIN"]}><Departments /></RequireAuth>} />
        <Route path="/admin/review" element={<RequireAuth roles={["ADMIN"]}><Review /></RequireAuth>} />
        <Route path="/records" element={<RequireAuth roles={["ADMIN", "OPERATOR", "STAFF"]}><Records /></RequireAuth>} />
        {/* Old addresses keep working. */}
        <Route path="/employees" element={<Navigate to="/admin/employees" replace />} />
        <Route path="/enroll" element={<Navigate to="/admin/enroll" replace />} />
        <Route path="/departments" element={<Navigate to="/admin/departments" replace />} />
        <Route path="/review" element={<Navigate to="/admin/review" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toaster />
    </>
  );
}
