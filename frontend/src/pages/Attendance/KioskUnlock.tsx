import { FormEvent, useEffect, useState } from "react";
import Icon from "../../components/Icon";
import { Modal, Spinner } from "../../components/ui";
import { errorMessage } from "../../services/api";

export default function KioskUnlock({ open, onClose, onUnlocked, unlock }: { open: boolean; onClose: () => void; onUnlocked: () => void; unlock: (password: string) => Promise<void> }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (open) {
      setPassword("");
      setError(null);
    }
  }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!password || checking) return;
    setChecking(true);
    setError(null);
    try {
      // Server-enforced: swaps the kiosk-locked session for a normal one.
      await unlock(password);
      onUnlocked();
    } catch (err: any) {
      const code = err?.response?.data?.code;
      setError(code === "WRONG_PASSWORD" ? "Wrong password. Try again." : errorMessage(err, "Could not verify the password."));
      setPassword("");
    } finally {
      setChecking(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Back to admin">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-neutral-400">Enter your password to leave the kiosk and open the admin portal.</p>
        <input
          type="password"
          className="input"
          placeholder="Password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-label="Password"
        />
        {error && (
          <p role="alert" className="text-sm text-red-300">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <button type="button" className="btn-ghost flex-1" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary flex-1" disabled={!password || checking}>
            {checking ? <Spinner /> : <Icon name="key" className="h-4 w-4" />} Unlock
          </button>
        </div>
      </form>
    </Modal>
  );
}
