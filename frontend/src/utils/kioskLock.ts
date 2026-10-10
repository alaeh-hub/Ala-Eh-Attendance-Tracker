// While the kiosk is on screen the admin portal is locked: the only way
// back is the password prompt on the kiosk. This is per-tab (sessionStorage),
// so closing the tab, or signing out, clears it.
const KEY = "kiosk_locked";

export function lockKiosk() {
  try {
    sessionStorage.setItem(KEY, "1");
  } catch {
    /* storage unavailable: the lock simply doesn't persist */
  }
}

export function unlockKiosk() {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}

export function isKioskLocked() {
  try {
    return sessionStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}
