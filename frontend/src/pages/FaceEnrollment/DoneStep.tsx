import { Link } from "react-router-dom";
import Icon from "../../components/Icon";
import { Avatar } from "../../components/ui";
import type { User } from "../../types";

/* Step 3 — done */

export default function DoneStep({ employee, onAnother }: { employee: User; onAnother: () => void }) {
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
    <div className="panel mx-auto max-w-xl overflow-hidden animate-scale-in">
      <div className="relative flex flex-col items-center border-b border-ink-700 px-4 pb-5 pt-8 text-center sm:px-6 sm:pb-6 sm:pt-10">
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
      <dl className="divide-y divide-white/[0.05] px-4 sm:px-6">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between py-3 text-sm">
            <dt className="text-neutral-500">{k}</dt>
            <dd className="font-medium text-neutral-200">{v || "—"}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap gap-2 border-t border-white/[0.06] p-4 sm:p-6">
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
