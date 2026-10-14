import type { Role } from "../../types";

/** Every role, including `KIOSK` (a device account). */
export type AnyRole = Role;

export const ROLE_HELP: Record<AnyRole, string> = {
  STAFF: "Clocks in at the kiosk. Web sign-in is optional (own attendance only).",
  OPERATOR: "Runs the kiosk and views records and reports.",
  ADMIN: "Full access, including employees, settings and corrections.",
  KIOSK: "Kiosk device sign-in: this account can only run the attendance kiosk on a tablet, never the admin pages. Requires a password.",
};

/** Roles that must be able to sign in (so they need a password). */
export function roleNeedsLogin(role: AnyRole) {
  return role !== "STAFF";
}
