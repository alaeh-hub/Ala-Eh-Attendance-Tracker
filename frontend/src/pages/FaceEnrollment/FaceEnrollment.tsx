import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useUserSearch } from "../../components/admin/EmployeePicker";
import { isCancelled, retryAfterSeconds } from "../../components/admin/request";
import { ROLE_HELP } from "../../components/admin/roles";
import CameraView, { CameraTone } from "../../components/CameraView";
import FaceDebugOverlay from "../../components/FaceDebugOverlay";
import Icon from "../../components/Icon";
import { Avatar, ConfirmDialog, Field, PageHeader, RoleBadge, Spinner, forgetPhoto } from "../../components/ui";
import { useCamera } from "../../hooks/useCamera";
import { SHORT_SCREEN, useOvalFit } from "../../hooks/useOvalFit";
import api, { errorMessage } from "../../services/api";
import { toast } from "../../stores/toastStore";
import type { Department, EnrollmentStatus, Role, User } from "../../types";
import { type FaceDebug, useFaceDebug } from "../../utils/faceDebug";
import { guideZone } from "../../utils/guideZone";
import { type VoiceKey, chime, isVoiceKey, preloadVoice, say, sayOnce, speak, stopSpeaking, useAudioUnlock } from "../../utils/sound";

const POSES: Record<string, { title: string; hint: string; arrow?: string }> = {
  frontal: { title: "Look straight ahead", hint: "Face the camera, neutral expression" },
  left: { title: "Turn slightly left", hint: "About 20°, keep eyes on screen", arrow: "←" },
  right: { title: "Turn slightly right", hint: "About 20°, keep eyes on screen", arrow: "→" },
  up: { title: "Tilt chin up a little", hint: "Small movement is enough", arrow: "↑" },
  down: { title: "Tilt chin down a little", hint: "Small movement is enough", arrow: "↓" },
  frontal_2: { title: "Straight ahead, smile", hint: "A natural smile helps with expression changes" },
};
const AUTO_CAPTURE_INTERVAL_MS = 700;
/** After a rejected capture, wait this long before readiness (and so auto-capture) resumes. */
const REJECT_PAUSE_MS = 1500;
// How long a banner stays up: a success is a quick confirmation, anything else has to be read.
const SUCCESS_NOTICE_MS = 1600;
const NOTICE_MS = 4500;
// A capture that keeps being refused would otherwise repeat "try again" every couple of seconds.
const RETRY_VOICE_GAP_MS = 8000;
// The spoken confirmation starts once the two-note chime has finished, so they don't talk over each other.
const VOICE_AFTER_CHIME_MS = 400;
// "Captured." / "Samples cleared." is spoken in front of the next pose, if that pose comes up within this long.
const LEAD_IN_MS = 3000;

type Step = 1 | 2 | 3;

/** What the capture screen tells the person being enrolled (a banner, plus a chime). */
type Notice = { tone: "success" | "warn" | "error"; title: string; text?: string };

type Calibration = { baselineYaw?: number; baselinePitch?: number; leftYaw?: number; upPitch?: number };
const calibrationKey = (userId: string) => `enroll_calibration_${userId}`;

function loadCalibration(userId: string): Calibration {
  try {
    return JSON.parse(sessionStorage.getItem(calibrationKey(userId)) || "{}") as Calibration;
  } catch {
    return {};
  }
}

function saveCalibration(userId: string, cal: Calibration | null) {
  try {
    if (cal) sessionStorage.setItem(calibrationKey(userId), JSON.stringify(cal));
    else sessionStorage.removeItem(calibrationKey(userId));
  } catch {
    /* storage unavailable: calibration just won't survive a refresh */
  }
}

const EMPTY_FORM = {
  full_name: "",
  employee_code: "",
  email: "",
  phone: "",
  department: "",
  position: "",
  role: "STAFF" as Role,
  allow_login: false,
  password: "",
};

function Stepper({ step }: { step: Step }) {
  const steps = ["Employee details", "Face capture", "Complete"];
  return (
    <ol className="mb-8 flex items-center gap-2 sm:gap-4 animate-fade-up">
      {steps.map((label, i) => {
        const n = (i + 1) as Step;
        const done = step > n;
        const active = step === n;
        return (
          <li key={label} className="flex flex-1 items-center gap-2 sm:gap-3">
            <span
              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-bold transition-all duration-300 ${
                done ? "bg-brand-500 text-black" : active ? "bg-brand-500/15 text-brand-300 ring-2 ring-brand-500" : "bg-white/[0.05] text-neutral-500"
              }`}
            >
              {done ? <Icon name="check" className="h-4 w-4" strokeWidth={3} /> : n}
            </span>
            <span className={`hidden text-sm font-semibold sm:block ${active ? "text-white" : done ? "text-neutral-300" : "text-neutral-500"}`}>{label}</span>
            {i < steps.length - 1 && <span className={`h-px flex-1 transition-colors duration-500 ${done ? "bg-brand-500" : "bg-white/10"}`} />}
          </li>
        );
      })}
    </ol>
  );
}

export default function FaceEnrollment() {
  const [params, setParams] = useSearchParams();
  const [step, setStep] = useState<Step>(1);
  const [employee, setEmployee] = useState<User | null>(null);

  // Deep link from the Employees page: /enroll?user=<id>
  useEffect(() => {
    const id = params.get("user");
    if (!id || employee?.id === id) return;
    api
      .get<User>(`/users/${id}`)
      .then((res) => {
        setEmployee(res.data);
        setStep(2);
      })
      .catch(() => toast.error("Employee not found"));
  }, [params, employee?.id]);

  function restart() {
    setEmployee(null);
    setStep(1);
    setParams({});
  }

  return (
    <>
      {/* The capture step takes over the whole screen, like the kiosk, so the header and stepper step aside. */}
      {step !== 2 && (
        <>
          <PageHeader title="Enroll employee" subtitle="Register an employee's details and face so they can clock in at the kiosk." />
          <Stepper step={step} />
        </>
      )}
      {step === 1 && (
        <EmployeeStep
          onReady={(u) => {
            setEmployee(u);
            setStep(2);
            setParams({ user: u.id });
          }}
        />
      )}
      {step === 2 && employee && <CaptureStep employee={employee} onBack={restart} onDone={(u) => { setEmployee(u); setStep(3); }} />}
      {step === 3 && employee && <DoneStep employee={employee} onAnother={restart} />}
    </>
  );
}

/* ----------------------------------------------------------------------------
 * Step 1 — details (new employee) or pick an existing one
 * ------------------------------------------------------------------------- */

function EmployeeStep({ onReady }: { onReady: (u: User) => void }) {
  const [mode, setMode] = useState<"new" | "existing">("new");
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState<Partial<Record<keyof typeof EMPTY_FORM, string>>>({});
  const [saving, setSaving] = useState(false);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [search, setSearch] = useState("");
  // Server-side search: never download the whole employee list.
  const { users, total, loading: loadingUsers, error: usersError } = useUserSearch(search, { status: "active", limit: 30, enabled: mode === "existing" });
  // Kiosk device accounts are tablets, not people: nothing to enroll.
  const people = users.filter((u) => u.role !== "KIOSK");

  useEffect(() => {
    api.get<Department[]>("/departments").then((r) => setDepartments(r.data)).catch(() => undefined);
    api.get("/users/next-code").then((r) => setForm((f) => (f.employee_code ? f : { ...f, employee_code: r.data.employee_code }))).catch(() => undefined);
  }, []);

  const selectedDept = departments.find((d) => d.name === form.department);

  const set = (k: keyof typeof EMPTY_FORM) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const value = e.target.type === "checkbox" ? (e.target as HTMLInputElement).checked : e.target.value;
    setForm((f) => ({ ...f, [k]: value }));
    setErrors((er) => ({ ...er, [k]: undefined }));
  };

  function validate() {
    const er: typeof errors = {};
    if (!form.full_name.trim()) er.full_name = "Full name is required.";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim())) er.email = "Enter a valid email address.";
    if (form.employee_code && !/^[A-Za-z0-9._-]{1,40}$/.test(form.employee_code.trim())) er.employee_code = "Letters, numbers, dot, dash, underscore only.";
    const needsPassword = form.allow_login || form.role !== "STAFF";
    if (needsPassword && (form.password.length < 8 || form.password.length > 72)) er.password = "8–72 characters.";
    setErrors(er);
    return Object.keys(er).length === 0;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving || !validate()) return;
    setSaving(true);
    try {
      const needsPassword = form.allow_login || form.role !== "STAFF";
      const res = await api.post<User>("/users", {
        full_name: form.full_name,
        employee_code: form.employee_code || undefined,
        email: form.email,
        phone: form.phone,
        department: form.department,
        position: form.position,
        role: form.role,
        password: needsPassword ? form.password : undefined,
      });
      if (res.data.role === "KIOSK") {
        // A device account has no face to enroll: it signs in on the kiosk tablet with its password.
        toast.success("Kiosk device account created", `Sign in as ${res.data.email} on the kiosk tablet.`);
        setForm({ ...EMPTY_FORM });
        setErrors({});
        api.get("/users/next-code").then((r) => setForm((f) => (f.employee_code ? f : { ...f, employee_code: r.data.employee_code }))).catch(() => undefined);
        return;
      }
      toast.success("Employee saved", `${res.data.full_name} · ${res.data.employee_code}`);
      onReady(res.data);
    } catch (err) {
      const msg = errorMessage(err, "Couldn't save the employee.");
      if (/email/i.test(msg)) setErrors({ email: msg });
      else if (/employee id/i.test(msg)) setErrors({ employee_code: msg });
      else toast.error("Couldn't save employee", msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="card overflow-hidden animate-fade-up">
      <div className="flex border-b border-white/[0.06]" role="tablist" aria-label="Employee">
        {(["new", "existing"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            onClick={() => setMode(m)}
            className={`relative flex-1 px-4 py-4 text-sm font-semibold transition-colors ${mode === m ? "text-white" : "text-neutral-500 hover:text-neutral-300"}`}
          >
            {m === "new" ? "New employee" : "Existing employee"}
            <span className={`absolute inset-x-6 bottom-0 h-0.5 rounded-full bg-brand-500 transition-transform duration-300 ${mode === m ? "scale-x-100" : "scale-x-0"}`} />
          </button>
        ))}
      </div>

      {mode === "new" ? (
        <form onSubmit={submit} className="p-6 animate-fade-in" noValidate>
          <h3 className="mb-1 text-sm font-bold uppercase tracking-wider text-brand-400">Personal information</h3>
          <p className="mb-5 text-sm text-neutral-500">Fields marked * are required.</p>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Full name *" error={errors.full_name}>
              <input className="input" value={form.full_name} onChange={set("full_name")} autoComplete="off" placeholder="Juan Dela Cruz" autoFocus />
            </Field>
            <Field label="Employee ID" hint="Auto-generated — you can change it." error={errors.employee_code}>
              <input className="input font-mono uppercase" value={form.employee_code} onChange={set("employee_code")} placeholder="EMP-0001" />
            </Field>
            <Field label="Email *" error={errors.email}>
              <input className="input" type="email" value={form.email} onChange={set("email")} autoComplete="off" placeholder="juan@company.com" />
            </Field>
            <Field label="Phone">
              <input className="input" type="tel" value={form.phone} onChange={set("phone")} placeholder="0917 123 4567" />
            </Field>
          </div>

          <h3 className="mb-4 mt-8 text-sm font-bold uppercase tracking-wider text-brand-400">Work information</h3>
          <div className="grid gap-5 sm:grid-cols-3">
            <Field label="Department">
              <select
                className="input"
                value={form.department}
                onChange={(e) => {
                  const value = e.target.value;
                  setForm((f) => ({ ...f, department: value, position: "" }));
                }}
              >
                <option value="">Select department…</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.name}>
                    {d.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Position">
              {selectedDept && selectedDept.roles.length > 0 ? (
                <select className="input" value={form.position} onChange={set("position")}>
                  <option value="">Select role…</option>
                  {selectedDept.roles.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              ) : (
                <input className="input" value={form.position} onChange={set("position")} placeholder="Line Operator" />
              )}
            </Field>
            <Field label="System role" hint={ROLE_HELP[form.role]}>
              <select className="input" value={form.role} onChange={set("role")}>
                <option value="STAFF">Staff — clocks in only</option>
                <option value="OPERATOR">Operator — runs kiosk & reports</option>
                <option value="ADMIN">Admin — full access</option>
                <option value="KIOSK">Kiosk device — tablet sign-in only</option>
              </select>
            </Field>
          </div>

          <div className="mt-8 rounded-2xl border border-white/[0.06] bg-white/[0.02] p-5">
            <label className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                className="mt-0.5 h-5 w-5 cursor-pointer rounded accent-brand-500"
                checked={form.allow_login || form.role !== "STAFF"}
                disabled={form.role !== "STAFF"}
                onChange={set("allow_login")}
              />
              <span>
                <span className="flex items-center gap-2 text-sm font-semibold text-white">
                  <Icon name="key" className="h-4 w-4 text-brand-400" /> {form.role === "KIOSK" ? "Device sign-in" : "Allow web sign-in"}
                </span>
                <span className="text-xs text-neutral-500">
                  {form.role === "KIOSK"
                    ? "Required: the kiosk tablet signs in with this email and password. It can only run the attendance kiosk."
                    : form.role !== "STAFF"
                      ? "Required for admins and operators."
                      : "Optional. Staff can view their own attendance history."}
                </span>
              </span>
            </label>
            {(form.allow_login || form.role !== "STAFF") && (
              <div className="mt-4 max-w-sm animate-fade-in">
                <Field label="Initial password *" error={errors.password} hint="Share it privately; they can use it to sign in.">
                  <input className="input" type="password" value={form.password} onChange={set("password")} autoComplete="new-password" />
                </Field>
              </div>
            )}
          </div>

          <div className="mt-8 flex justify-end">
            <button type="submit" className="btn-primary min-h-12 w-full px-6 sm:w-auto" disabled={saving}>
              {saving ? <Spinner /> : null}
              {saving ? "Saving…" : form.role === "KIOSK" ? "Create kiosk device account" : "Save & continue to face capture"}
              {!saving && <Icon name="arrow_right" className="h-4 w-4" />}
            </button>
          </div>
        </form>
      ) : (
        <div className="p-6 animate-fade-in">
          <div className="relative mb-4">
            <Icon name="search" className="absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500" />
            <input
              className="input pl-10"
              placeholder="Search by name, ID, email or department…"
              aria-label="Search employees"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
            />
          </div>
          <div className="max-h-[440px] space-y-1 overflow-y-auto" aria-busy={loadingUsers}>
            {loadingUsers && people.length === 0 && Array.from({ length: 4 }).map((_, i) => <div key={i} className="skeleton h-16 w-full rounded-xl" />)}
            {!loadingUsers && people.length === 0 && (
              <p className="py-10 text-center text-sm text-neutral-500">{usersError ? "Couldn't load employees." : "No matching active employees."}</p>
            )}
            {people.map((u) => (
              <button
                key={u.id}
                type="button"
                onClick={() => onReady(u)}
                className="group flex w-full items-center gap-4 rounded-xl border border-transparent p-3 text-left transition-all hover:border-brand-500/30 hover:bg-brand-500/[0.06]"
              >
                <Avatar userId={u.id} name={u.full_name} hasPhoto={u.has_photo} size="h-11 w-11" />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-white">{u.full_name}</p>
                  <p className="truncate text-xs text-neutral-500">{[u.employee_code, u.department, u.position].filter(Boolean).join(" · ") || u.email}</p>
                </div>
                {u.enrolled ? (
                  <span className="chip bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/25">{u.sample_count} samples</span>
                ) : (
                  <span className="chip bg-orange-500/10 text-orange-300 ring-1 ring-orange-500/25">Not enrolled</span>
                )}
                <Icon name="arrow_right" className="h-4 w-4 text-neutral-600 transition-transform group-hover:translate-x-0.5 group-hover:text-brand-400" />
              </button>
            ))}
            {total > users.length && (
              <p className="px-3 py-2 text-xs text-neutral-500">
                Showing the first {users.length} of {total} — keep typing to narrow down.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Step 2 — guided capture
 * ------------------------------------------------------------------------- */

function CaptureStep({ employee, onBack, onDone }: { employee: User; onBack: () => void; onDone: (u: User) => void }) {
  const { videoRef, ready, starting, error: cameraError, start, stop, captureFrame, devices, deviceId, isInfrared, switchCamera } = useCamera();
  const [poses, setPoses] = useState<string[]>(Object.keys(POSES));
  const [status, setStatus] = useState<EnrollmentStatus | null>(null);
  const [captured, setCaptured] = useState<string[]>([]);
  const [auto, setAuto] = useState(true);
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState<{ text: string; tone: CameraTone } | null>(null);
  const [blocking, setBlocking] = useState<string | null>(null); // duplicate / inconsistent face
  const [flash, setFlash] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [consent, setConsent] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [readiness, setReadiness] = useState<{ ready: boolean; score: number; reason: string | null } | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [soundOn, setSoundOn] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const topBarRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  // The face window takes the room between the top bar (and the pose banner under it) and the controls.
  const ovalStyle = useOvalFit({
    container: containerRef,
    top: topBarRef,
    bottom: dockRef,
    // The pose banner sits under the top bar (beside it on a short screen). The floor is the size the oval had before it was measured.
    topReserve: (c) => (c.height <= SHORT_SCREEN ? 56 : c.width >= 640 ? 216 : 200),
    floorShare: (c) => (c.height <= SHORT_SCREEN ? 0.52 : c.width > c.height ? 0.44 : c.width >= 640 ? 0.46 : 0.44),
  });
  // Development only: what the server's detector saw, drawn over the camera.
  const faceDebug = useFaceDebug();
  const { wants: wantsDebug, report: reportDebug } = faceDebug;
  // Read through a ref so toggling sound never changes the capture callback (and so never resets auto-capture timers).
  const soundRef = useRef(true);
  soundRef.current = soundOn;
  useAudioUnlock();
  useEffect(() => preloadVoice(), []);
  const lastRetryVoice = useRef(0);
  const leadIn = useRef<{ key: VoiceKey; at: number } | null>(null);
  // "All done" is only worth saying when this person just finished the last pose, not when an already complete enrollment is reopened.
  const capturedThisSession = useRef(false);
  const busyRef = useRef(false);
  const checkingRef = useRef(false);
  // The first frame that passed the readiness check for the current pose, with the head angles
  // measured on it. Calibration is only committed from it once the server ACCEPTS the sample.
  const readyFrameRef = useRef<{ blob: Blob; pose: string; yaw: number; pitch: number } | null>(null);
  // Readiness checks (and therefore auto-capture) are paused until this time: after a rejected
  // capture, so the same rejected frame isn't resubmitted every few hundred ms, and after a 429.
  const pauseUntilRef = useRef(0);
  // Calibration against THIS employee's own poses, so left/right and
  // up/down are told apart by contrast rather than an absolute guess —
  // see backend app/vision/pose.py for why. baseline = this employee's
  // frontal reading; leftYaw/upPitch = their deviation on the first pose
  // of each pair, required to be in the opposite direction for the second.
  // Kept in sessionStorage too, so refreshing mid-enrollment doesn't lose the calibration the
  // remaining poses are judged against.
  const calibration = useRef<Calibration>(loadCalibration(employee.id));
  const ovalRef = useRef<HTMLDivElement>(null);

  const refreshStatus = useCallback(async () => {
    const res = await api.get<EnrollmentStatus>("/enrollment/status", { params: { target_user_id: employee.id } });
    setStatus(res.data);
    setCaptured(res.data.poses_captured);
    return res.data;
  }, [employee.id]);

  /** Show a banner and, unless sound is off, play the matching chime. */
  const notify = useCallback((n: Notice, opts?: { silent?: boolean }) => {
    setNotice(n);
    if (soundRef.current && !opts?.silent) chime(n.tone === "success");
  }, []);

  useEffect(() => {
    api.get("/enrollment/poses").then((r) => setPoses(r.data.poses)).catch(() => undefined);
    refreshStatus().catch(() => notify({ tone: "error", title: "Couldn't load progress", text: "Check the connection and try again." }));
    start();
  }, [refreshStatus, start, notify]);

  // Banners clear themselves: a success quickly, anything else once there has been time to read it.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), notice.tone === "success" ? SUCCESS_NOTICE_MS : NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else containerRef.current?.requestFullscreen?.();
  }

  const remaining = poses.filter((p) => !captured.includes(p));
  const currentPose = remaining[0];
  const minRequired = status?.min_required ?? 5;
  const count = status?.sample_count ?? 0;
  const allPosesDone = remaining.length === 0;
  const canFinish = count >= minRequired;
  // Biometric consent is recorded once per employee, on their first sample.
  const consentOk = !!status?.consent_recorded || consent;

  // Live readiness preview: polls a cheap quality/pose check a few times a
  // second so the person sees "turn a bit more" / a percentage before any
  // real capture is attempted, instead of the camera firing blind.
  useEffect(() => {
    if (!ready || !currentPose || blocking || allPosesDone) {
      setReadiness(null);
      readyFrameRef.current = null;
      return;
    }
    let cancelled = false;
    readyFrameRef.current = null;
    const base = currentPose!.split("_")[0];
    async function tick() {
      if (cancelled || checkingRef.current || busyRef.current || Date.now() < pauseUntilRef.current) return;
      checkingRef.current = true;
      try {
        const blob = await captureFrame(0.92);
        if (!blob || cancelled) return;
        const form = new FormData();
        form.append("image", blob, "check.jpg");
        form.append("pose", currentPose!);
        const zone = guideZone(videoRef.current, ovalRef.current);
        if (zone) form.append("zone", JSON.stringify(zone));
        const cal = calibration.current;
        if (cal.baselineYaw !== undefined && cal.baselinePitch !== undefined) {
          form.append("baseline_yaw", String(cal.baselineYaw));
          form.append("baseline_pitch", String(cal.baselinePitch));
        }
        if (base === "right" && cal.leftYaw !== undefined) form.append("reference_yaw", String(cal.leftYaw));
        if (base === "down" && cal.upPitch !== undefined) form.append("reference_pitch", String(cal.upPitch));

        if (wantsDebug()) form.append("debug", "1");

        const res = await api.post<{ ready: boolean; score: number; reason: string | null; yaw: number | null; pitch: number | null; debug?: FaceDebug }>("/enrollment/check", form);
        reportDebug(res.data.debug);
        // A check that was already in flight when a capture got rejected (or a 429 arrived) is stale.
        if (cancelled || busyRef.current || Date.now() < pauseUntilRef.current) return;
        setReadiness(res.data);

        if (!res.data.ready) readyFrameRef.current = null;

        // Keep the first frame which actually passes readiness. The sample
        // is submitted from this checked frame, so continued movement during
        // the auto-capture delay cannot turn a valid pose into an extreme one.
        if (res.data.ready && res.data.yaw != null && res.data.pitch != null && !readyFrameRef.current) {
          readyFrameRef.current = { blob, pose: currentPose!, yaw: res.data.yaw, pitch: res.data.pitch };
        }
      } catch (err) {
        if (cancelled || isCancelled(err)) return;
        const wait = retryAfterSeconds(err);
        if (wait !== null) {
          // Rate limited: back off for as long as the server asks instead of hammering it.
          pauseUntilRef.current = Date.now() + wait * 1000;
          readyFrameRef.current = null;
          setReadiness(null);
          setHint({ text: `Too many checks — pausing for ${Math.ceil(wait)} s.`, tone: "warn" });
          notify({ tone: "warn", title: "Please wait a moment", text: `Too many checks. Pausing for ${Math.ceil(wait)} s.` }, { silent: true });
          if (soundRef.current) sayOnce("enroll.wait", RETRY_VOICE_GAP_MS);
        }
        /* other failures are transient — the next tick retries */
      } finally {
        checkingRef.current = false;
      }
    }
    tick();
    const t = setInterval(tick, 350);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [ready, currentPose, blocking, allPosesDone, captureFrame, videoRef, notify, wantsDebug, reportDebug]);

  /** Record calibration from a frame whose sample the server accepted (never from a rejected one). */
  const commitCalibration = useCallback(
    (frame: { pose: string; yaw: number; pitch: number }) => {
      const cal = calibration.current;
      const base = frame.pose.split("_")[0];
      if (base === "frontal" && cal.baselineYaw === undefined) {
        cal.baselineYaw = frame.yaw;
        cal.baselinePitch = frame.pitch;
      } else if (base === "left" && cal.leftYaw === undefined) {
        cal.leftYaw = frame.yaw - (cal.baselineYaw ?? 0);
      } else if (base === "up" && cal.upPitch === undefined) {
        cal.upPitch = frame.pitch - (cal.baselinePitch ?? 0);
      } else {
        return;
      }
      saveCalibration(employee.id, cal);
    },
    [employee.id]
  );

  const capture = useCallback(async () => {
    if (busyRef.current || !currentPose || blocking) return;
    busyRef.current = true;
    setBusy(true);
    const frame = readyFrameRef.current?.pose === currentPose ? readyFrameRef.current : null;
    // Whatever happens, this frame is used at most once.
    readyFrameRef.current = null;
    try {
      const blob = frame?.blob ?? (await captureFrame(0.92));
      if (!blob) return;
      const form = new FormData();
      form.append("image", blob, "capture.jpg");
      form.append("pose", currentPose);
      form.append("target_user_id", employee.id);
      const zone = guideZone(videoRef.current, ovalRef.current);
      if (zone) form.append("zone", JSON.stringify(zone));
      if (consent) form.append("consent", "true");
      const res = await api.post<EnrollmentStatus & { quality_score: number }>("/enrollment/sample", form);
      if (frame) commitCalibration(frame);
      setStatus(res.data);
      setCaptured(res.data.poses_captured);
      setFlash(true);
      setReadiness(null);
      setTimeout(() => setFlash(false), 350);
      capturedThisSession.current = true;
      leadIn.current = { key: "enroll.captured", at: Date.now() };
      const quality = Math.round(res.data.quality_score * 100);
      setHint({ text: `Captured · quality ${quality}%`, tone: "success" });
      notify({ tone: "success", title: "Captured", text: `Quality ${quality}%` });
    } catch (err: any) {
      const code = err?.response?.data?.code;
      const msg = errorMessage(err, "Capture rejected — try again.");
      // Don't let auto-capture resubmit the same rejected frame: wait for fresh readiness checks.
      const wait = retryAfterSeconds(err);
      pauseUntilRef.current = Date.now() + (wait !== null ? wait * 1000 : REJECT_PAUSE_MS);
      setReadiness(null);
      if (code === "DUPLICATE_FACE" || code === "INCONSISTENT_FACE") {
        setBlocking(msg);
        setAuto(false);
        if (soundRef.current) {
          chime(false);
          say("enroll.blocked", 400);
        }
      } else if (wait !== null) {
        setHint({ text: `Too many attempts — pausing for ${Math.ceil(wait)} s.`, tone: "warn" });
        notify({ tone: "warn", title: "Please wait a moment", text: `Too many attempts. Pausing for ${Math.ceil(wait)} s.` });
        if (soundRef.current) sayOnce("enroll.wait", RETRY_VOICE_GAP_MS, 400);
      } else {
        setHint({ text: msg, tone: "warn" });
        notify({ tone: "warn", title: "Not captured", text: msg });
        if (soundRef.current && Date.now() - lastRetryVoice.current > RETRY_VOICE_GAP_MS) {
          lastRetryVoice.current = Date.now();
          say("retry");
        }
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [captureFrame, currentPose, employee.id, blocking, consent, videoRef, commitCalibration, notify]);

  // Auto-capture: only fires once the live readiness check says the pose
  // and quality are good, giving the employee time to get into position
  // instead of the camera snapping the instant a frame arrives. A short
  // pause after a success gives them time to move into the next pose.
  useEffect(() => {
    if (!auto || !ready || !currentPose || blocking || !readiness?.ready || !consentOk || (status?.outdated_samples ?? 0) > 0) return;
    const t = setTimeout(capture, hint?.tone === "success" ? 1400 : AUTO_CAPTURE_INTERVAL_MS);
    return () => clearTimeout(t);
  }, [auto, ready, currentPose, blocking, busy, capture, hint, status?.outdated_samples, readiness?.ready, consentOk]);

  useEffect(() => {
    if (allPosesDone) stop();
  }, [allPosesDone, stop]);

  // Turning the head means looking away from the screen, so each new pose is also spoken, after
  // "Captured." (or "Samples cleared.") when that is what led to it, and after the chime for it.
  const outdatedCount = status?.outdated_samples ?? 0;
  useEffect(() => {
    if (!soundOn || !ready || !currentPose || blocking || !consentOk || outdatedCount > 0) return;
    const lead = leadIn.current && Date.now() - leadIn.current.at < LEAD_IN_MS ? leadIn.current.key : null;
    leadIn.current = null;
    const key = `pose.${currentPose}`;
    if (isVoiceKey(key)) {
      if (lead) say([lead, key], VOICE_AFTER_CHIME_MS);
      else say(key);
    } else speak(POSES[currentPose]?.title ?? "Look at the camera"); // a pose the server added that has no recording yet
    return stopSpeaking;
  }, [soundOn, ready, currentPose, blocking, consentOk, outdatedCount]);

  // The other steps that stop the capture and need someone to act.
  const awaitingConsent = !!status && !consentOk;
  useEffect(() => {
    if (soundOn && awaitingConsent && !blocking) say("enroll.consent");
  }, [soundOn, awaitingConsent, blocking]);

  useEffect(() => {
    if (soundOn && outdatedCount > 0 && !blocking && !awaitingConsent) say("enroll.outdated");
  }, [soundOn, outdatedCount, blocking, awaitingConsent]);

  useEffect(() => {
    if (allPosesDone && capturedThisSession.current && soundRef.current) say("done");
  }, [allPosesDone]);

  async function reset() {
    if (resetting) return;
    setResetting(true);
    try {
      const res = await api.delete<EnrollmentStatus>("/enrollment/samples", { params: { target_user_id: employee.id } });
      setStatus(res.data);
      setCaptured([]);
      calibration.current = {};
      saveCalibration(employee.id, null);
      readyFrameRef.current = null;
      pauseUntilRef.current = 0;
      setBlocking(null);
      setHint(null);
      forgetPhoto(employee.id);
      setConfirmReset(false);
      leadIn.current = { key: "enroll.cleared", at: Date.now() };
      notify({ tone: "success", title: "Samples cleared", text: "Start capturing again." });
      start();
    } catch (err) {
      notify({ tone: "error", title: "Couldn't clear samples", text: errorMessage(err) });
    } finally {
      setResetting(false);
    }
  }

  async function finish() {
    if (finishing) return;
    setFinishing(true);
    try {
      const res = await api.get<User>(`/users/${employee.id}`);
      saveCalibration(employee.id, null);
      forgetPhoto(employee.id);
      onDone(res.data);
    } catch (err) {
      notify({ tone: "error", title: "Couldn't finish enrollment", text: errorMessage(err, "Check the connection and try again. The captured samples are saved.") });
      setFinishing(false);
    }
  }

  const pose = currentPose ? POSES[currentPose] ?? { title: "Look at the camera", hint: "" } : null;
  const poseNumber = Math.min(captured.length + 1, poses.length);

  // The same glass styling as the kiosk's controls.
  const glass = "border border-white/10 bg-black/55 backdrop-blur-md";
  const hudBtn = `${glass} flex h-12 min-w-12 items-center justify-center gap-2 rounded-full px-4 text-base font-semibold text-white transition-colors hover:bg-black/75 active:scale-95`;
  const dockBtn =
    "flex h-14 min-w-14 items-center justify-center gap-2 rounded-2xl px-4 text-base font-bold transition-all active:scale-[.97] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100 sm:h-16 sm:text-lg";
  const ghostBtn = `${dockBtn} border border-white/15 bg-white/[0.06] text-neutral-100 hover:bg-white/10`;

  const needsConsent = !!status && !status.consent_recorded && !consent;
  const outdated = status?.outdated_samples ?? 0;
  // One thing at a time takes over the screen; the banner and controls step aside for it.
  const panelOpen = !!blocking || needsConsent || outdated > 0 || allPosesDone;
  const showBanner = !panelOpen && (!!notice || (ready && !!pose));

  const noticeStyle = {
    success: { box: "border-emerald-400/50", badge: "bg-emerald-500 text-black", icon: "check" as const },
    warn: { box: "border-orange-400/50", badge: "bg-orange-500 text-black", icon: "alert" as const },
    error: { box: "border-red-500/50", badge: "bg-red-500 text-white", icon: "x_circle" as const },
  };

  return (
    <div ref={containerRef} className="fixed inset-0 z-40 touch-manipulation select-none overflow-hidden bg-black animate-fade-in">
      <CameraView
        fill
        ovalRef={ovalRef}
        videoRef={videoRef}
        ready={ready && !allPosesDone}
        starting={starting}
        onStart={allPosesDone ? undefined : start}
        tone={blocking || notice?.tone === "error" ? "error" : notice?.tone ?? (busy ? "scanning" : readiness?.ready ? "success" : "idle")}
        scanning={busy}
        isInfrared={isInfrared}
        devices={devices}
        deviceId={deviceId}
        onSwitchCamera={switchCamera}
        toolsClass="right-4 top-24 sm:top-28"
        // Until the real layout has been measured (see useOvalFit), these percentages stand in for it.
        ovalClass="top-[50%] h-[44%] sm:top-[51%] sm:h-[46%] [@media(orientation:landscape)_and_(min-height:521px)]:top-[53%] [@media(orientation:landscape)_and_(min-height:521px)]:h-[44%] [@media(max-height:520px)]:top-[52%] [@media(max-height:520px)]:h-[52%]"
        ovalStyle={ovalStyle}
        overlay={flash ? <div className="absolute inset-0 bg-white/40 animate-fade-in" /> : undefined}
      />
      <FaceDebugOverlay debug={faceDebug} kind="enroll" />

      <div className="pointer-events-none absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-black/70 to-transparent" />
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-72 bg-gradient-to-t from-black/70 to-transparent" />

      {/* Top bar: who is being enrolled on the left, window controls on the right */}
      <div ref={topBarRef} className="absolute inset-x-0 top-0 flex items-start justify-between gap-3 px-[max(1rem,env(safe-area-inset-left))] pt-[max(1rem,env(safe-area-inset-top))] sm:px-6 sm:pt-6">
        <div className="flex min-w-0 items-center gap-3 sm:gap-4">
          <Avatar userId={employee.id} name={employee.full_name} hasPhoto={!!status?.has_photo} size="h-12 w-12 sm:h-16 sm:w-16" text="text-base" version={count} ring />
          <div className="min-w-0 drop-shadow">
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand-400">Enrolling</p>
            <p className="truncate text-xl font-extrabold leading-tight text-white sm:text-3xl">{employee.full_name}</p>
            <p className="truncate text-xs text-neutral-300 sm:text-sm">{[employee.employee_code, employee.department].filter(Boolean).join(" · ")}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <button onClick={() => setSoundOn((s) => !s)} className={hudBtn} aria-pressed={soundOn} title={soundOn ? "Sounds and spoken prompts on" : "Sounds and spoken prompts off"} aria-label={soundOn ? "Turn sound off" : "Turn sound on"}>
            <Icon name={soundOn ? "volume" : "volume_off"} className={`h-5 w-5 ${soundOn ? "text-brand-400" : "text-neutral-400"}`} />
            <span className="hidden lg:inline">{soundOn ? "Sound on" : "Sound off"}</span>
          </button>
          <button onClick={toggleFullscreen} className={hudBtn} title="Toggle fullscreen" aria-label="Toggle fullscreen">
            <Icon name="expand" className="h-5 w-5" />
            <span className="hidden lg:inline">{fullscreen ? "Exit fullscreen" : "Fullscreen"}</span>
          </button>
          <button onClick={onBack} className={hudBtn} title="Leave without finishing (captured samples are kept)" aria-label="Back">
            <Icon name="arrow_left" className="h-5 w-5" />
            <span className="hidden md:inline">Back</span>
          </button>
        </div>
      </div>

      {/* The instruction (or the latest result) sits above the face window so it never covers the face. */}
      {showBanner && (
        <div className="pointer-events-none absolute inset-x-0 top-24 flex justify-center px-4 sm:top-28 [@media(max-height:520px)]:top-3 [@media(max-height:520px)]:px-[19rem]">
          {notice ? (
            <div
              key={`${notice.tone}-${notice.title}-${notice.text}`}
              role={notice.tone === "success" ? "status" : "alert"}
              className={`${glass} flex w-full max-w-xl items-center gap-4 rounded-3xl p-3 animate-fade-up sm:p-4 ${noticeStyle[notice.tone].box}`}
            >
              <span className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl sm:h-16 sm:w-16 ${noticeStyle[notice.tone].badge}`}>
                <Icon name={noticeStyle[notice.tone].icon} className="h-8 w-8" strokeWidth={2.6} />
              </span>
              <div className="min-w-0">
                <p className="text-xl font-extrabold leading-tight text-white sm:text-2xl">{notice.title}</p>
                {notice.text && <p className="text-sm text-neutral-200 sm:text-base">{notice.text}</p>}
              </div>
            </div>
          ) : (
            pose && (
              <div key={currentPose} role="status" className={`${glass} w-full max-w-xl overflow-hidden rounded-3xl animate-fade-up`}>
                <div className="flex items-center gap-4 p-3 sm:p-4">
                  <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-brand-500 text-3xl font-black text-black sm:h-16 sm:w-16 sm:text-4xl">
                    {pose.arrow ?? <Icon name="scan" className="h-8 w-8" strokeWidth={2.2} />}
                  </span>
                  <div className="min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-wider text-brand-300">
                      Pose {poseNumber} of {poses.length}
                    </p>
                    <p className="text-2xl font-extrabold leading-tight text-white sm:text-3xl">{pose.title}</p>
                    <p className="text-sm text-neutral-300 [@media(max-height:520px)]:hidden">{readiness && !readiness.ready && readiness.reason ? readiness.reason : pose.hint}</p>
                  </div>
                  {readiness?.ready && (
                    <span className="ml-auto shrink-0 rounded-full bg-emerald-500 px-3 py-1 text-sm font-bold text-black">Ready</span>
                  )}
                </div>
                <div className="h-1.5 bg-white/10" aria-hidden="true">
                  <div className={`h-full transition-all duration-200 ${readiness?.ready ? "bg-emerald-400" : "bg-orange-400"}`} style={{ width: `${Math.round((readiness?.score ?? 0) * 100)}%` }} />
                </div>
              </div>
            )
          )}
        </div>
      )}

      {cameraError && (
        <p role="alert" className="absolute inset-x-4 top-48 mx-auto flex max-w-xl items-center gap-2 rounded-xl border border-red-500/40 bg-black/80 px-4 py-3 text-sm text-red-300 backdrop-blur">
          <Icon name="alert" className="h-4 w-4 shrink-0" /> {cameraError}
        </p>
      )}

      {/* Control dock: progress, then the big buttons */}
      {!allPosesDone && (
        <div className="absolute inset-x-0 bottom-0 flex justify-center px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-6">
          <div ref={dockRef} className={`${glass} w-full max-w-3xl space-y-3 rounded-3xl p-3 sm:p-4`}>
            <div className="flex items-center gap-3">
              <ol className="flex flex-1 items-center gap-1.5" aria-label="Pose progress">
                {poses.map((p) => (
                  <li
                    key={p}
                    title={POSES[p]?.title ?? p}
                    className={`h-2.5 flex-1 rounded-full transition-colors duration-300 ${captured.includes(p) ? "bg-emerald-400" : p === currentPose ? "bg-brand-400 animate-pulse" : "bg-white/15"}`}
                  />
                ))}
              </ol>
              <span className="shrink-0 text-sm font-semibold tabular-nums text-neutral-100">
                {count} / {minRequired}
                <span className="hidden text-neutral-400 sm:inline"> needed</span>
              </span>
            </div>

            <div className="flex flex-wrap gap-2">
              <button type="button" className={ghostBtn} onClick={() => setConfirmReset(true)} disabled={count === 0 || resetting} aria-label="Start over" title="Delete the captured samples and begin again">
                <Icon name="refresh" className="h-5 w-5" />
                <span className="hidden sm:inline">Start over</span>
              </button>
              {ready && (
                <button
                  type="button"
                  aria-pressed={auto}
                  onClick={() => setAuto((a) => !a)}
                  disabled={!!blocking}
                  className={`${dockBtn} flex-1 border ${auto ? "border-brand-500/50 bg-brand-500/15 text-brand-300" : "border-white/15 bg-white/[0.06] text-neutral-100 hover:bg-white/10"}`}
                >
                  <Icon name={auto ? "bolt" : "pause"} className="h-5 w-5" />
                  {auto ? "Auto-capture on" : "Auto-capture paused"}
                </button>
              )}
              {ready && !auto && (
                <button type="button" onClick={capture} className={`${dockBtn} flex-1 bg-brand-500 text-black shadow-[0_0_40px_-8px_rgba(245,192,0,.8)] hover:bg-brand-400`} disabled={busy || !!blocking || !readiness?.ready || !consentOk}>
                  {busy ? <Spinner /> : <Icon name="camera" className="h-5 w-5" />} {readiness?.ready ? "Capture pose" : "Not ready yet"}
                </button>
              )}
              {canFinish && (
                <button type="button" onClick={finish} disabled={finishing} aria-busy={finishing} className={`${dockBtn} flex-1 bg-emerald-500 text-black hover:bg-emerald-400`}>
                  {finishing ? <Spinner /> : <Icon name="check" className="h-5 w-5" strokeWidth={3} />} Finish
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Things that need an answer take over the screen, like the kiosk's result overlays. */}
      {blocking && (
        <KioskPanel tone="error">
          <span className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-red-500 text-white">
            <Icon name="shield" className="h-10 w-10" strokeWidth={2.2} />
          </span>
          <p role="alert" className="text-2xl font-extrabold text-white sm:text-3xl">Capture blocked for accuracy</p>
          <p className="mt-2 text-base text-red-200">{blocking}</p>
          <div className="mt-6 grid gap-2">
            <button className={`${dockBtn} bg-brand-500 text-black hover:bg-brand-400`} onClick={() => { setBlocking(null); setHint(null); }}>
              <Icon name="refresh" className="h-5 w-5" /> Dismiss &amp; retry
            </button>
            <button className={ghostBtn} onClick={onBack}>
              Choose a different employee
            </button>
          </div>
        </KioskPanel>
      )}

      {!blocking && needsConsent && (
        <KioskPanel tone="info">
          <span className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-brand-500 text-black">
            <Icon name="shield" className="h-10 w-10" strokeWidth={2.2} />
          </span>
          <p className="text-2xl font-extrabold text-white sm:text-3xl">Biometric consent</p>
          <p className="mt-2 text-base text-neutral-300">{employee.full_name} has agreed to their face being stored for attendance. Capture starts once you confirm.</p>
          <div className="mt-6 grid gap-2">
            <button className={`${dockBtn} bg-brand-500 text-black hover:bg-brand-400`} onClick={() => setConsent(true)}>
              <Icon name="check" className="h-5 w-5" strokeWidth={3} /> They agree. Start
            </button>
            <button className={ghostBtn} onClick={onBack}>
              Back
            </button>
          </div>
        </KioskPanel>
      )}

      {!blocking && !needsConsent && outdated > 0 && (
        <KioskPanel tone="warn">
          <span className="mx-auto mb-4 flex h-20 w-20 items-center justify-center rounded-full bg-orange-500 text-black">
            <Icon name="alert" className="h-10 w-10" strokeWidth={2.2} />
          </span>
          <p className="text-2xl font-extrabold text-white sm:text-3xl">Re-enrollment needed</p>
          <p className="mt-2 text-base text-neutral-300">{outdated} samples were captured with the previous recognition engine and can't be used. Clear them, then capture again.</p>
          <div className="mt-6 grid gap-2">
            <button className={`${dockBtn} bg-brand-500 text-black hover:bg-brand-400`} onClick={reset} disabled={resetting}>
              {resetting ? <Spinner /> : <Icon name="refresh" className="h-5 w-5" />} Clear old samples
            </button>
            <button className={ghostBtn} onClick={onBack}>
              Back
            </button>
          </div>
        </KioskPanel>
      )}

      {allPosesDone && !blocking && (
        <KioskPanel tone="success">
          <div className="relative mx-auto mb-4 h-24 w-24">
            <span className="absolute -inset-3 rounded-full bg-emerald-500/25 animate-pulse-ring" />
            <span className="relative flex h-24 w-24 items-center justify-center rounded-full bg-emerald-500 text-black">
              <svg viewBox="0 0 24 24" className="h-12 w-12" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6 9 17l-5-5" strokeDasharray="48" className="animate-draw-check" />
              </svg>
            </span>
          </div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-brand-400">All poses captured</p>
          <p className="mt-1 text-2xl font-extrabold text-white sm:text-3xl">{employee.full_name}</p>
          <p className="mt-1 text-sm text-neutral-400">{count} face samples saved. The camera is turned off.</p>
          <div className="mt-6 grid gap-2">
            <button className={`${dockBtn} bg-emerald-500 text-black hover:bg-emerald-400`} onClick={finish} disabled={!canFinish || finishing} aria-busy={finishing}>
              {finishing ? <Spinner /> : <Icon name="check" className="h-5 w-5" strokeWidth={3} />} Finish enrollment
            </button>
            <button className={ghostBtn} onClick={() => setConfirmReset(true)} disabled={count === 0}>
              <Icon name="refresh" className="h-5 w-5" /> Start over
            </button>
          </div>
        </KioskPanel>
      )}

      <ConfirmDialog
        open={confirmReset}
        title="Start over?"
        message={<>This deletes all {count} saved face samples for <b className="text-white">{employee.full_name}</b>. They'll need to be captured again.</>}
        confirmLabel="Delete samples"
        danger
        busy={resetting}
        onConfirm={reset}
        onClose={() => !resetting && setConfirmReset(false)}
      />
    </div>
  );
}

/** A centred card over a dimmed, blurred camera: the enrollment version of the kiosk's result overlays. */
function KioskPanel({ children, tone }: { children: React.ReactNode; tone: "success" | "info" | "warn" | "error" }) {
  const border = { success: "border-emerald-400/40", info: "border-brand-500/40", warn: "border-orange-400/40", error: "border-red-500/40" }[tone];
  return (
    <div className="absolute inset-0 z-10 flex overflow-y-auto bg-black/75 p-4 backdrop-blur-md animate-fade-in">
      <div className={`m-auto w-full max-w-md rounded-3xl border bg-black/60 p-6 text-center animate-scale-in sm:p-8 ${border}`}>{children}</div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
 * Step 3 — done
 * ------------------------------------------------------------------------- */

function DoneStep({ employee, onAnother }: { employee: User; onAnother: () => void }) {
  const rows: [string, string | null][] = [
    ["Employee ID", employee.employee_code],
    ["Email", employee.email],
    ["Department", employee.department],
    ["Position", employee.position],
    ["Phone", employee.phone],
    ["Face samples", String(employee.sample_count)],
    ["Web sign-in", employee.can_login ? "Enabled" : "Kiosk only"],
  ];
  return (
    <div className="card mx-auto max-w-xl overflow-hidden animate-scale-in">
      <div className="relative flex flex-col items-center bg-gradient-to-b from-brand-500/15 to-transparent px-6 pb-6 pt-10 text-center">
        <div className="relative">
          <span className="absolute -inset-3 rounded-full bg-emerald-500/20 animate-pulse-ring" />
          <Avatar userId={employee.id} name={employee.full_name} hasPhoto={employee.has_photo} size="h-28 w-28" text="text-3xl" ring version={1} />
          <span className="absolute -bottom-1 -right-1 rounded-full bg-emerald-500 p-2 text-black ring-4 ring-ink-850">
            <Icon name="check" className="h-5 w-5" strokeWidth={3} />
          </span>
        </div>
        <h2 className="mt-5 text-2xl font-extrabold text-white">{employee.full_name} is enrolled</h2>
        <p className="mt-1 text-sm text-neutral-400">They can now clock in and out at any kiosk.</p>
      </div>
      <dl className="divide-y divide-white/[0.05] px-6">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between py-3 text-sm">
            <dt className="text-neutral-500">{k}</dt>
            <dd className="font-medium text-neutral-200">{v || "—"}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap gap-2 border-t border-white/[0.06] p-6">
        <button className="btn-primary flex-1" onClick={onAnother}>
          <Icon name="plus" className="h-4 w-4" /> Enroll another
        </button>
        <Link to="/kiosk" className="btn-ghost flex-1">
          <Icon name="scan" className="h-4 w-4" /> Test at kiosk
        </Link>
        <Link to="/admin/employees" className="btn-ghost flex-1">
          <Icon name="users" className="h-4 w-4" /> Employees
        </Link>
      </div>
    </div>
  );
}
