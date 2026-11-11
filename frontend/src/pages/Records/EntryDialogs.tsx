import { useMemo, useRef, useState } from "react";
import { useDiscardGuard } from "../../components/useDiscardGuard";
import EmployeePicker, { PickedEmployee } from "../../components/admin/EmployeePicker";
import { DateTimeField, Select } from "../../components/fields";
import { Field, Modal, Spinner } from "../../components/ui";
import api, { errorMessage } from "../../services/api";
import { toast } from "../../stores/toastStore";
import { datetimeLocalToApi, formatDate, formatTime, toDatetimeLocal } from "../../utils/orgTime";
import { type EventRow, SHORT_DATE } from "./recordsUtils";

export function ManualEntry({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [employee, setEmployee] = useState<PickedEmployee | null>(null);
  // `datetime-local` holds org-local wall time; it is sent as-is (naive) and the server applies the org timezone.
  const [form, setForm] = useState(() => ({ event_type: "CLOCK_IN", session: "", timestamp: toDatetimeLocal(), notes: "" }));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const initialManual = useRef(JSON.stringify(form));
  const { requestClose, dialog: discardDialog } = useDiscardGuard(!!employee || JSON.stringify(form) !== initialManual.current, onClose, saving);

  async function save() {
    if (saving) return;
    if (!employee || !form.notes.trim() || !form.timestamp) {
      setError("Choose an employee, a date and time, and give a reason.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.post("/attendance", {
        user_id: employee.id,
        event_type: form.event_type,
        session: form.session || undefined,
        timestamp: datetimeLocalToApi(form.timestamp),
        notes: form.notes.trim(),
      });
      toast.success("Manual entry saved", "Recorded in the audit log.");
      onSaved();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={requestClose}
      title="Manual attendance entry"
      footer={
        <>
          <button className="btn-ghost" onClick={requestClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn-primary" onClick={save} disabled={saving}>
            {saving && <Spinner />} Save entry
          </button>
        </>
      }
    >
      <p className="mb-4 rounded-xl bg-brand-500/10 px-3 py-2 text-xs text-brand-200">
        Use only when the kiosk couldn't be used (camera down, injury, etc.). Every manual entry is audited.
      </p>
      <div className="space-y-4">
        <EmployeePicker value={employee} onChange={setEmployee} autoFocus />
        <div className="grid grid-cols-2 gap-3">
          <Field label="Event">
            <Select className="input" value={form.event_type} onChange={(e) => setForm({ ...form, event_type: e.target.value })}>
              <option value="CLOCK_IN">Clock in</option>
              <option value="CLOCK_OUT">Clock out</option>
            </Select>
          </Field>
          <Field label="Session">
            <Select className="input" value={form.session} onChange={(e) => setForm({ ...form, session: e.target.value })}>
              <option value="">Auto (from time)</option>
              <option value="AM">AM</option>
              <option value="PM">PM</option>
              <option value="OT">OT</option>
            </Select>
          </Field>
        </div>
        <Field label="Date & time" hint="Organisation time. Future times aren't accepted.">
          <DateTimeField className="input" value={form.timestamp} max={toDatetimeLocal()} onChange={(e) => setForm({ ...form, timestamp: e.target.value })} />
        </Field>
        <Field label="Reason">
          <input className="input" value={form.notes} maxLength={255} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="e.g. Kiosk camera offline" />
        </Field>
        {error && (
          <p role="alert" className="text-sm text-red-300">
            {error}
          </p>
        )}
      </div>
      {discardDialog}
    </Modal>
  );
}

export /** Correct an existing punch: type, session, time and note. Only changed fields are sent. */
function CorrectEntry({ event, onClose, onSaved }: { event: EventRow; onClose: () => void; onSaved: (e: EventRow) => void }) {
  const initial = useMemo(
    () => ({ event_type: event.event_type, session: event.session, timestamp: toDatetimeLocal(event.timestamp), notes: event.notes ?? "" }),
    [event]
  );
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { requestClose, dialog: discardDialog } = useDiscardGuard(JSON.stringify(form) !== JSON.stringify(initial), onClose, saving);

  async function save() {
    if (saving) return;
    const changes: Record<string, string | null> = {};
    if (form.event_type !== initial.event_type) changes.event_type = form.event_type;
    if (form.session !== initial.session) changes.session = form.session;
    if (form.timestamp !== initial.timestamp) {
      if (!form.timestamp) {
        setError("Enter a date and time.");
        return;
      }
      changes.timestamp = datetimeLocalToApi(form.timestamp);
    }
    if (form.notes !== initial.notes) changes.notes = form.notes.trim() || null;
    if (Object.keys(changes).length === 0) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await api.patch<EventRow>(`/attendance/${event.id}`, changes);
      toast.success("Record corrected", "The before/after values were written to the audit log.");
      onSaved(res.data);
    } catch (err) {
      setError(errorMessage(err, "Couldn't save the correction."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open
      onClose={requestClose}
      title="Correct attendance record"
      footer={
        <>
          <button className="btn-ghost" onClick={requestClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn-primary" onClick={save} disabled={saving}>
            {saving && <Spinner />} Save correction
          </button>
        </>
      }
    >
      <p className="mb-4 text-sm text-neutral-400">
        <b className="text-white">{event.user_name}</b> · {formatDate(event.timestamp, SHORT_DATE)} {formatTime(event.timestamp)}
      </p>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Event">
            <Select className="input" value={form.event_type} onChange={(e) => setForm({ ...form, event_type: e.target.value as EventRow["event_type"] })}>
              <option value="CLOCK_IN">Clock in</option>
              <option value="CLOCK_OUT">Clock out</option>
            </Select>
          </Field>
          <Field label="Session">
            <Select className="input" value={form.session} onChange={(e) => setForm({ ...form, session: e.target.value as EventRow["session"] })}>
              <option value="AM">AM</option>
              <option value="PM">PM</option>
              <option value="OT">OT</option>
            </Select>
          </Field>
        </div>
        <Field label="Date & time" hint="Organisation time.">
          <DateTimeField className="input" value={form.timestamp} max={toDatetimeLocal()} onChange={(e) => setForm({ ...form, timestamp: e.target.value })} />
        </Field>
        <Field label="Note">
          <input className="input" value={form.notes} maxLength={255} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Why this record was corrected" />
        </Field>
        {error && (
          <p role="alert" className="text-sm text-red-300">
            {error}
          </p>
        )}
      </div>
      {discardDialog}
    </Modal>
  );
}
