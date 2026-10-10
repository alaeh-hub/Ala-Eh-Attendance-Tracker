import { Suspense, lazy, useEffect } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import AppShell, { homeFor } from "./components/AppShell";
import KioskShell from "./components/KioskShell";
import Toaster from "./components/Toaster";
import Login from "./pages/Login/Login";
import { Spinner } from "./components/ui";
import api from "./services/api";
import { useAuthStore } from "./stores/authStore";
import { toast } from "./stores/toastStore";
import type { Role } from "./types";
import { isKioskLocked } from "./utils/kioskLock";

const AttendanceKiosk = lazy(() => import("./pages/Attendance/AttendanceKiosk"));
const Dashboard = lazy(() => import("./pages/Dashboard/Dashboard"));
const Reports = lazy(() => import("./pages/Reports/Reports"));
const Employees = lazy(() => import("./pages/Employees/Employees"));
const Departments = lazy(() => import("./pages/Departments/Departments"));
const FaceEnrollment = lazy(() => import("./pages/FaceEnrollment/FaceEnrollment"));
const Records = lazy(() => import("./pages/Records/Records"));
const Review = lazy(() => import("./pages/Review/Review"));

function RequireAuth({ roles, kiosk, children }: { roles?: Role[]; kiosk?: boolean; children: JSX.Element }) {
  const user = useAuthStore((s) => s.user);
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (roles && !roles.includes(user.role)) return <Navigate to={homeFor(user.role)} replace />;
  // While the kiosk is up, staff of the portal can only get back in through its password prompt.
  if (!kiosk && user.role !== "STAFF" && isKioskLocked()) return <Navigate to="/kiosk" replace />;
  const Shell = kiosk ? KioskShell : AppShell;
  return (
    <Shell>
      <Suspense fallback={<div className="flex justify-center py-24 text-brand-400"><Spinner className="h-7 w-7" /></div>}>{children}</Suspense>
    </Shell>
  );
}

function HomeRedirect() {
  const user = useAuthStore((s) => s.user);
  const location = useLocation();
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Navigate to={homeFor(user.role)} replace />;
}

export default function App() {
  const setUser = useAuthStore((s) => s.setUser);
  const logout = useAuthStore((s) => s.logout);

  // Re-validate the rehydrated session in the background so a revoked or
  // deactivated account is logged out instead of showing stale UI.
  useEffect(() => {
    const accessToken = localStorage.getItem("access_token");
    const refreshToken = localStorage.getItem("refresh_token");
    if (accessToken && refreshToken) {
      api.get("/auth/me").then((res) => {
        // Access tokens may rotate during this request. The refresh token
        // stays stable until logout or a different account signs in.
        if (localStorage.getItem("refresh_token") === refreshToken) setUser(res.data);
      }).catch(() => undefined);
    }
    const onExpired = () => {
      logout();
      toast.info("Session ended", "Please sign in again.");
    };
    window.addEventListener("auth:expired", onExpired);
    return () => window.removeEventListener("auth:expired", onExpired);
  }, [setUser, logout]);

  return (
    <>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<HomeRedirect />} />
        {/* Kiosk: full-screen, no admin menu. */}
        <Route path="/kiosk" element={<RequireAuth kiosk roles={["ADMIN", "OPERATOR"]}><AttendanceKiosk /></RequireAuth>} />
        {/* Admin portal: everything for managing the system lives under /admin. */}
        <Route path="/admin" element={<RequireAuth roles={["ADMIN", "OPERATOR"]}><Dashboard /></RequireAuth>} />
        <Route path="/admin/reports" element={<RequireAuth roles={["ADMIN"]}><Reports /></RequireAuth>} />
        <Route path="/admin/employees" element={<RequireAuth roles={["ADMIN"]}><Employees /></RequireAuth>} />
        <Route path="/admin/enroll" element={<RequireAuth roles={["ADMIN"]}><FaceEnrollment /></RequireAuth>} />
        <Route path="/admin/departments" element={<RequireAuth roles={["ADMIN"]}><Departments /></RequireAuth>} />
        <Route path="/admin/review" element={<RequireAuth roles={["ADMIN"]}><Review /></RequireAuth>} />
        <Route path="/records" element={<RequireAuth><Records /></RequireAuth>} />
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
