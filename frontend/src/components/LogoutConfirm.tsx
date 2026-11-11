import { useState } from "react";
import { useAuthStore } from "../stores/authStore";
import { ConfirmDialog } from "./ui";

/**
 * Signing out always asks first: a stray tap on a shared office PC or a kiosk tablet should not end the session.
 * `ask()` opens the dialog; render `dialog` once next to the button that calls it.
 */
export function useLogoutConfirm() {
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const dialog = (
    <ConfirmDialog
      open={open}
      title="Sign out?"
      confirmLabel="Sign out"
      busy={busy}
      message={
        <>
          {user ? (
            <p>
              Signed in as <b className="text-white">{user.full_name}</b>.
            </p>
          ) : null}
          <p className="mt-2">You'll need your password to get back in.</p>
        </>
      }
      onClose={() => !busy && setOpen(false)}
      onConfirm={async () => {
        setBusy(true);
        try {
          await logout();
        } finally {
          setBusy(false);
          setOpen(false);
        }
      }}
    />
  );
  return { ask: () => setOpen(true), dialog };
}
