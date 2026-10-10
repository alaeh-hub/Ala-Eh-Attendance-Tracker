import { ReactNode, useEffect } from "react";
import { lockKiosk } from "../utils/kioskLock";

/**
 * The kiosk owns the entire viewport: no sidebar, no header. The camera page
 * draws all of its controls on top of the video. Mounting it locks the admin
 * portal until the password prompt is passed (see KioskUnlock).
 */
export default function KioskShell({ children }: { children: ReactNode }) {
  useEffect(() => lockKiosk(), []);
  return <div className="fixed inset-0 overflow-hidden bg-black">{children}</div>;
}
