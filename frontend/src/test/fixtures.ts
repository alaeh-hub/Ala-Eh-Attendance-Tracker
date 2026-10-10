import type { ScanSnapshot, User } from "../types";

export const admin: User = {
  id: "admin-1",
  full_name: "Ada Admin",
  email: "admin@example.test",
  role: "ADMIN",
  employee_code: "EMP-0001",
  department: "Office",
  position: "Manager",
  phone: null,
  has_photo: false,
  can_login: true,
  is_active: true,
  enrolled: true,
  sample_count: 6,
  created_at: "2026-01-01T00:00:00Z",
};

export const maria: User = {
  ...admin,
  id: "user-2",
  full_name: "Maria Santos",
  email: "maria@example.test",
  role: "STAFF",
  employee_code: "EMP-0002",
  department: "Production",
  position: "Packer",
  can_login: false,
  sample_count: 6,
};

export const juan: User = { ...maria, id: "user-3", full_name: "Juan Dela Cruz", email: "juan@example.test", employee_code: "EMP-0003", enrolled: false, sample_count: 0 };

export function snapshot(over: Partial<ScanSnapshot> = {}): ScanSnapshot {
  return {
    id: "snap-1",
    status: "NO_MATCH",
    score: 0.31,
    runner_up_score: 0.2,
    spoof_score: null,
    device_id: "kiosk-1",
    user_id: null,
    user_name: null,
    candidate_user_id: maria.id,
    candidate_name: maria.full_name,
    event_id: null,
    resolution: null,
    created_at: new Date().toISOString(),
    ...over,
  };
}

/** An axios-style error with a JSON body, as the backend returns it. */
export function apiError(status: number, body: Record<string, unknown>) {
  return Object.assign(new Error(body.error as string), { response: { status, data: body } });
}
