import type { FaceDebug } from "../utils/faceDebug";

/** KIOSK is a device account: it signs in on a kiosk tablet and is always kiosk-locked. */
export type Role = "ADMIN" | "STAFF" | "OPERATOR" | "KIOSK";

export interface Shift {
  name: string;
  start_time: string;
  end_time: string;
}

export interface Department {
  id: string;
  name: string;
  start_time: string | null;
  end_time: string | null;
  break_start: string | null;
  break_end: string | null;
  has_shifting: boolean;
  shifts: Shift[];
  roles: string[];
  employee_count: number;
  created_at: string;
}

export interface User {
  id: string;
  full_name: string;
  email: string;
  role: Role;
  employee_code: string | null;
  department: string | null;
  position: string | null;
  phone: string | null;
  has_photo: boolean;
  can_login: boolean;
  consent_recorded?: boolean;
  is_active: boolean;
  enrolled: boolean;
  sample_count: number;
  created_at: string;
}

export interface AttendanceEvent {
  id: string;
  user_id: string;
  user_name: string | null;
  employee_code: string | null;
  department: string | null;
  has_photo: boolean;
  event_type: "CLOCK_IN" | "CLOCK_OUT";
  session: "AM" | "PM" | "OT";
  timestamp: string;
  /** The shift's work day ("YYYY-MM-DD"); differs from the calendar date for night shifts. */
  work_date?: string;
  /** Scheduled start of the shift ("HH:MM"), when known. */
  scheduled_start?: string | null;
  scheduled_end?: string | null;
  local_time?: string;
  is_late?: boolean;
  late_minutes?: number | null;
  is_early_leave?: boolean;
  early_minutes?: number | null;
  punch_label?: string;
  /** True when the recorded punch differs from the kiosk button pressed. */
  corrected?: boolean;
  correction_note?: string | null;
  requested_label?: string | null;
  match_score: number;
  match_status: string;
  liveness_passed: boolean;
  device_id: string | null;
  notes: string | null;
}

export interface EnrollmentStatus {
  user_id: string;
  engine: string;
  sample_count: number;
  outdated_samples: number;
  min_required: number;
  max_samples: number;
  enrollment_complete: boolean;
  poses_captured: string[];
  average_quality: number | null;
  has_photo: boolean;
  consent_recorded: boolean;
}

export type CheckInStatus =
  | "NO_FACE"
  | "NO_MATCH"
  | "LOW_CONFIDENCE"
  | "AMBIGUOUS_MATCH"
  | "LIVENESS_FAILED"
  | "SPOOF_SUSPECTED"
  | "COOLDOWN"
  | "VERIFIED"
  | "MATCHED"
  // Client-side only
  | "CONNECTION_ERROR"
  | "REQUEST_ERROR";

export interface CheckInResult {
  status: CheckInStatus;
  reason?: string;
  score?: number;
  first_name?: string;
  user_id?: string;
  user_name?: string;
  has_photo?: boolean;
  event?: AttendanceEvent;
  /** MATCHED: the punch written differs from the button pressed. */
  corrected?: boolean;
  correction_note?: string | null;
  /** MATCHED: how long a re-scan will only re-verify this punch. */
  reverify_seconds?: number;
  /** VERIFIED: seconds left in that window, or null once it has closed. */
  seconds_remaining?: number | null;
  elapsed_ms?: number;
  frames_with_face?: number;
  /** Development servers only, when asked for: what the face detector saw (see utils/faceDebug). */
  debug?: FaceDebug;
}

export interface TodayReport {
  date: string;
  timezone: string;
  total_employees: number;
  enrolled: number;
  present: number;
  currently_in: number;
  late: number;
  absent: number;
  events_today: number;
  hourly: { hour: number; clock_in: number; clock_out: number }[];
  departments: { department: string; total: number; present: number }[];
}

export interface DailyRow {
  date: string;
  user_id: string;
  user_name: string;
  employee_code: string | null;
  department: string | null;
  first_in: string | null;
  last_out: string | null;
  hours: number;
  ot_hours: number;
  total_hours: number;
  late: boolean;
  open: boolean;
  events: number;
  /** Work day the row belongs to (the date the shift started); same as `date`. */
  work_date?: string;
  scheduled_start?: string | null;
  scheduled_end?: string | null;
  late_minutes?: number | null;
  early_leave?: boolean;
  early_minutes?: number | null;
}

export interface ScanSnapshot {
  id: string;
  status: "MATCHED" | "NO_MATCH" | "LOW_CONFIDENCE" | "AMBIGUOUS_MATCH" | "SPOOF_SUSPECTED" | "LIVENESS_FAILED";
  score: number | null;
  runner_up_score: number | null;
  spoof_score: number | null;
  device_id: string | null;
  user_id: string | null;
  user_name: string | null;
  candidate_user_id: string | null;
  candidate_name: string | null;
  event_id: string | null;
  resolution: "ADDED" | "DISMISSED" | null;
  created_at: string;
}
