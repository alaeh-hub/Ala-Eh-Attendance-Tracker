import { ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { errorMessage } from "../services/api";
import { useAuthStore } from "../stores/authStore";
import Icon from "./Icon";
import { Spinner } from "./ui";

/**
 * The kiosk owns the entire viewport: no sidebar, no header. The camera page
 * draws all of its controls on top of the video.
 *
 * Entering locks the session on the server (POST /auth/kiosk/lock): the
 * tokens are swapped for kiosk-locked ones that can only reach the kiosk
 * endpoints, so the admin portal stays shut even if someone edits the URL or
 * reloads. Only the password prompt (POST /auth/kiosk/unlock) lifts it.
 */
export default function KioskShell({ children }: { children: ReactNode }) {
  const kioskLocked = useAuthStore((s) => s.kioskLocked);
  const lockKiosk = useAuthStore((s) => s.lockKiosk);
  const leavingKiosk = useAuthStore((s) => s.leavingKiosk);
  const logout = useAuthStore((s) => s.logout);
  const isDeviceAccount = useAuthStore((s) => s.user?.role === "KIOSK");
  const [error, setError] = useState<string | null>(null);
  const [locking, setLocking] = useState(false);
  const attempted = useRef(false);
  const navigate = useNavigate();

  const lock = useCallback(async () => {
    setLocking(true);
    setError(null);
    try {
      await lockKiosk();
    } catch (err) {
      setError(errorMessage(err, "Couldn't start the kiosk."));
    } finally {
      setLocking(false);
    }
  }, [lockKiosk]);

  useEffect(() => {
    // After an unlock the admin portal is about to open; locking again would bounce the user back here.
    if (kioskLocked || leavingKiosk || attempted.current) return;
    attempted.current = true;
    lock();
  }, [kioskLocked, leavingKiosk, lock]);

  return (
    <div className="fixed inset-0 overflow-hidden bg-black">
      {kioskLocked ? (
        children
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-4 px-4 text-center" role="status" aria-live="polite">
          {error ? (
            <>
              <p className="flex items-center gap-2 text-sm text-red-300">
                <Icon name="alert" className="h-4 w-4" /> {error}
              </p>
              <div className="flex gap-2">
                {isDeviceAccount ? (
                  <button className="btn-ghost" onClick={() => void logout()}>
                    Sign out
                  </button>
                ) : (
                  <button className="btn-ghost" onClick={() => navigate("/admin")}>
                    Back to admin
                  </button>
                )}
                <button className="btn-primary" onClick={lock} disabled={locking}>
                  {locking ? <Spinner /> : <Icon name="refresh" className="h-4 w-4" />} Try again
                </button>
              </div>
            </>
          ) : (
            <p className="flex items-center gap-2 text-sm text-neutral-300">
              <Spinner /> Starting the kiosk…
            </p>
          )}
        </div>
      )}
    </div>
  );
}
