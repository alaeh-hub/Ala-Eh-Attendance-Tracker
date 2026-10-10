import { useCallback, useEffect, useState } from "react";
import Icon from "../../components/Icon";
import { ConfirmDialog, EmptyState, Modal, PageHeader, Spinner, timeAgo } from "../../components/ui";
import api, { errorMessage } from "../../services/api";
import { toast } from "../../stores/toastStore";
import type { ScanSnapshot, User } from "../../types";

type Filter = "pending" | "matched" | "resolved" | "all";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "pending", label: "Needs review" },
  { key: "matched", label: "Check-ins" },
  { key: "resolved", label: "Resolved" },
  { key: "all", label: "Everything" },
];

const STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  MATCHED: { label: "Matched", cls: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/25" },
  NO_MATCH: { label: "Unknown face", cls: "bg-orange-500/10 text-orange-300 ring-orange-500/25" },
  LOW_CONFIDENCE: { label: "Low confidence", cls: "bg-orange-500/10 text-orange-300 ring-orange-500/25" },
  AMBIGUOUS_MATCH: { label: "Ambiguous", cls: "bg-orange-500/10 text-orange-300 ring-orange-500/25" },
  SPOOF_SUSPECTED: { label: "Possible spoof", cls: "bg-red-500/10 text-red-300 ring-red-500/30" },
  LIVENESS_FAILED: { label: "No blink", cls: "bg-white/[0.06] text-neutral-300 ring-white/10" },
};

// Snapshots need the auth header, so they're fetched as blobs.
function useSnapshotImage(id: string) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let alive = true;
    api
      .get(`/review/snapshots/${id}/image`, { responseType: "blob" })
      .then((res) => {
        url = URL.createObjectURL(res.data);
        if (alive) setSrc(url);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [id]);
  return src;
}

function SnapshotCard({ snap, onEnroll, onDismiss, onDelete }: { snap: ScanSnapshot; onEnroll: () => void; onDismiss: () => void; onDelete: () => void }) {
  const src = useSnapshotImage(snap.id);
  const style = STATUS_STYLE[snap.status] ?? STATUS_STYLE.NO_MATCH;
  const actionable = snap.status !== "MATCHED" && !snap.resolution;
  return (
    <div className="card overflow-hidden animate-fade-up">
      <div className="relative aspect-[4/3] bg-black/60">
        {src ? <img src={src} alt="Scan snapshot" className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-brand-400"><Spinner className="h-6 w-6" /></div>}
        <span className={`chip absolute left-2 top-2 ring-1 ${style.cls}`}>{style.label}</span>
        {snap.resolution && <span className="chip absolute right-2 top-2 bg-black/70 text-neutral-200">{snap.resolution === "ADDED" ? "Added as sample" : "Dismissed"}</span>}
      </div>
      <div className="p-3">
        <p className="truncate text-sm font-semibold text-white">{snap.user_name ?? (snap.candidate_name ? `Closest: ${snap.candidate_name}` : "No close match")}</p>
        <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs tabular-nums text-neutral-500">
          <span>{timeAgo(snap.created_at)}</span>
          {snap.score !== null && <span>score {snap.score.toFixed(2)}</span>}
          {snap.spoof_score !== null && <span>live {snap.spoof_score.toFixed(2)}</span>}
          {snap.device_id && <span>{snap.device_id}</span>}
        </p>
        <div className="mt-3 flex gap-2">
          {actionable && (
            <>
              <button className="btn-primary flex-1 py-2 text-xs" onClick={onEnroll}>
                <Icon name="enroll" className="h-3.5 w-3.5" /> Add as sample
              </button>
              <button className="btn-ghost py-2 text-xs" onClick={onDismiss}>
                Dismiss
              </button>
            </>
          )}
          <button className="rounded-lg p-2 text-neutral-500 transition-colors hover:bg-red-500/10 hover:text-red-300" onClick={onDelete} title="Delete snapshot" aria-label="Delete snapshot">
            <Icon name="trash" className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function EnrollModal({ snap, onClose, onDone }: { snap: ScanSnapshot; onClose: () => void; onDone: () => void }) {
  const [users, setUsers] = useState<User[]>([]);
  const [userId, setUserId] = useState(snap.candidate_user_id ?? snap.user_id ?? "");
  const [busy, setBusy] = useState(false);
  const [needsConsent, setNeedsConsent] = useState(false);

  useEffect(() => {
    api.get<User[]>("/users", { params: { status: "active" } }).then((r) => setUsers(r.data)).catch(() => toast.error("Couldn't load employees"));
  }, []);

  async function submit(consent = false) {
    if (!userId) return;
    setBusy(true);
    try {
      await api.post(`/review/snapshots/${snap.id}/enroll`, { user_id: userId, consent });
      toast.success("Sample added", "Recognition will use this photo from now on.");
      onDone();
    } catch (err: any) {
      if (err?.response?.data?.code === "CONSENT_REQUIRED") setNeedsConsent(true);
      else toast.error("Couldn't add sample", errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Add as enrollment sample"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {needsConsent ? (
            <button className="btn-primary" onClick={() => submit(true)} disabled={busy}>
              {busy && <Spinner />} Employee consented — add
            </button>
          ) : (
            <button className="btn-primary" onClick={() => submit()} disabled={busy || !userId}>
              {busy && <Spinner />} Add sample
            </button>
          )}
        </>
      }
    >
      <p className="mb-3 text-sm text-neutral-400">
        Only add a frame you have checked by eye. It is rejected automatically if the face doesn't resemble the chosen employee's existing samples, or is already enrolled as someone else.
      </p>
      <select className="input" value={userId} onChange={(e) => setUserId(e.target.value)} aria-label="Employee">
        <option value="">Choose employee…</option>
        {users.map((u) => (
          <option key={u.id} value={u.id}>
            {u.full_name} {u.employee_code ? `(${u.employee_code})` : ""}
          </option>
        ))}
      </select>
      {needsConsent && (
        <p role="alert" className="mt-3 rounded-xl border border-orange-400/30 bg-orange-500/10 px-4 py-2.5 text-sm text-orange-200">
          No biometric consent is on file for this employee. Confirm they agreed to face recognition to continue.
        </p>
      )}
    </Modal>
  );
}

export default function Review() {
  const [filter, setFilter] = useState<Filter>("pending");
  const [items, setItems] = useState<ScanSnapshot[]>([]);
  const [total, setTotal] = useState(0);
  const [pending, setPending] = useState(0);
  const [loading, setLoading] = useState(true);
  const [enrolling, setEnrolling] = useState<ScanSnapshot | null>(null);
  const [deleting, setDeleting] = useState<ScanSnapshot | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<{ items: ScanSnapshot[]; total: number; pending_count: number }>("/review/snapshots", { params: { filter, limit: 60 } });
      setItems(res.data.items);
      setTotal(res.data.total);
      setPending(res.data.pending_count);
    } catch (err) {
      toast.error("Couldn't load snapshots", errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    load();
  }, [load]);

  async function dismiss(s: ScanSnapshot) {
    try {
      await api.post(`/review/snapshots/${s.id}/dismiss`);
      load();
    } catch (err) {
      toast.error("Couldn't dismiss", errorMessage(err));
    }
  }

  async function remove(s: ScanSnapshot) {
    try {
      await api.delete(`/review/snapshots/${s.id}`);
      setDeleting(null);
      load();
    } catch (err) {
      toast.error("Couldn't delete", errorMessage(err));
    }
  }

  return (
    <>
      <PageHeader
        title="Scan review"
        subtitle={`${pending} need review · unmatched scans and check-in snapshots are kept for audit, then deleted automatically.`}
        actions={
          <button className="btn-ghost" onClick={load} disabled={loading}>
            <Icon name="refresh" className="h-4 w-4" /> Refresh
          </button>
        }
      />

      <div className="mb-4 flex flex-wrap gap-1 rounded-xl border border-white/10 bg-white/[0.03] p-1 sm:inline-flex" role="group" aria-label="Filter">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`rounded-lg px-3.5 py-1.5 text-sm font-semibold transition-colors ${filter === f.key ? "bg-brand-500 text-black" : "text-neutral-400 hover:text-white"}`}
          >
            {f.label}
            {f.key === "pending" && pending > 0 && <span className="ml-1.5 rounded-full bg-black/25 px-1.5 text-xs tabular-nums">{pending}</span>}
          </button>
        ))}
      </div>

      {loading && items.length === 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="skeleton h-64 w-full rounded-2xl" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="card">
          <EmptyState icon="shield" title={filter === "pending" ? "Nothing to review" : "No snapshots here"} message="Unknown faces, low-confidence scans and suspected spoofs show up here." />
        </div>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {items.map((s) => (
              <SnapshotCard key={s.id} snap={s} onEnroll={() => setEnrolling(s)} onDismiss={() => dismiss(s)} onDelete={() => setDeleting(s)} />
            ))}
          </div>
          {total > items.length && <p className="mt-4 text-center text-xs text-neutral-500">Showing the latest {items.length} of {total}.</p>}
        </>
      )}

      {enrolling && (
        <EnrollModal
          snap={enrolling}
          onClose={() => setEnrolling(null)}
          onDone={() => {
            setEnrolling(null);
            load();
          }}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        title="Delete snapshot?"
        danger
        confirmLabel="Delete"
        message="This permanently deletes the saved frame. The attendance record it belongs to is kept."
        onConfirm={() => deleting && remove(deleting)}
        onClose={() => setDeleting(null)}
      />
    </>
  );
}
