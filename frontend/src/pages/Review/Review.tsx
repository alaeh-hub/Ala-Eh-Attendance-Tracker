import { useCallback, useEffect, useRef, useState } from "react";
import EmployeePicker, { PickedEmployee } from "../../components/admin/EmployeePicker";
import { isCancelled, useLatestRequest } from "../../components/admin/request";
import Icon from "../../components/Icon";
import { ConfirmDialog, EmptyState, Modal, PageHeader, Spinner, timeAgo } from "../../components/ui";
import api, { errorMessage } from "../../services/api";
import { toast } from "../../stores/toastStore";
import type { ScanSnapshot } from "../../types";
import { formatDateTime } from "../../utils/orgTime";

type Filter = "pending" | "matched" | "resolved" | "all";

const FILTERS: { key: Filter; label: string }[] = [
  { key: "pending", label: "Needs review" },
  { key: "matched", label: "Check-ins" },
  { key: "resolved", label: "Resolved" },
  { key: "all", label: "Everything" },
];

const PAGE_SIZE = 48;

const STATUS_STYLE: Record<string, { label: string; cls: string }> = {
  MATCHED: { label: "Matched", cls: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/25" },
  NO_MATCH: { label: "Unknown face", cls: "bg-orange-500/10 text-orange-300 ring-orange-500/25" },
  LOW_CONFIDENCE: { label: "Low confidence", cls: "bg-orange-500/10 text-orange-300 ring-orange-500/25" },
  AMBIGUOUS_MATCH: { label: "Ambiguous", cls: "bg-orange-500/10 text-orange-300 ring-orange-500/25" },
  SPOOF_SUSPECTED: { label: "Possible spoof", cls: "bg-red-500/10 text-red-300 ring-red-500/30" },
  LIVENESS_FAILED: { label: "No blink", cls: "bg-white/[0.06] text-neutral-300 ring-white/10" },
};

type ListResponse = { items: ScanSnapshot[]; total: number; pending_count: number };

// Snapshots need the auth header, so they're fetched as blobs.
function useSnapshotImage(id: string) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let alive = true;
    api
      .get(`/review/snapshots/${id}/image`, { responseType: "blob" })
      .then((res) => {
        const created = URL.createObjectURL(res.data);
        // The card may have unmounted before the image arrived: release the blob right away.
        if (!alive) {
          URL.revokeObjectURL(created);
          return;
        }
        url = created;
        setSrc(created);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [id]);
  return src;
}

function SnapshotCard({
  snap,
  busy,
  onEnroll,
  onDismiss,
  onDelete,
}: {
  snap: ScanSnapshot;
  busy: boolean;
  onEnroll: () => void;
  onDismiss: () => void;
  onDelete: () => void;
}) {
  const src = useSnapshotImage(snap.id);
  const style = STATUS_STYLE[snap.status] ?? STATUS_STYLE.NO_MATCH;
  const actionable = snap.status !== "MATCHED" && !snap.resolution;
  // A suspected spoof (photo / screen) must never become a face sample; the server refuses it too.
  const enrollable = actionable && snap.status !== "SPOOF_SUSPECTED";
  const who = snap.user_name ?? (snap.candidate_name ? `Closest: ${snap.candidate_name}` : "No close match");
  return (
    <div className="card overflow-hidden animate-fade-up">
      <div className="relative aspect-[4/3] bg-black/60">
        {src ? (
          <img src={src} alt={`Scan snapshot, ${style.label.toLowerCase()}`} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center text-brand-400">
            <Spinner className="h-6 w-6" />
          </div>
        )}
        <span className={`chip absolute left-2 top-2 ring-1 ${style.cls}`}>{style.label}</span>
        {snap.resolution && <span className="chip absolute right-2 top-2 bg-black/70 text-neutral-200">{snap.resolution === "ADDED" ? "Added as sample" : "Dismissed"}</span>}
      </div>
      <div className="p-3">
        <p className="truncate text-sm font-semibold text-white">{who}</p>
        <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs tabular-nums text-neutral-500">
          <time dateTime={snap.created_at} title={formatDateTime(snap.created_at)}>
            {timeAgo(snap.created_at)}
          </time>
          {snap.score !== null && <span>score {snap.score.toFixed(2)}</span>}
          {snap.spoof_score !== null && <span>live {snap.spoof_score.toFixed(2)}</span>}
          {snap.device_id && <span>{snap.device_id}</span>}
        </p>
        {actionable && !enrollable && <p className="mt-2 text-xs text-red-300/90">Suspected spoof — can't be added as a face sample.</p>}
        <div className="mt-3 flex gap-2">
          {actionable && (
            <>
              {enrollable && (
                <button className="btn-primary flex-1 py-2 text-xs" onClick={onEnroll} disabled={busy}>
                  <Icon name="enroll" className="h-3.5 w-3.5" /> Add as sample
                </button>
              )}
              <button className={`btn-ghost py-2 text-xs ${enrollable ? "" : "flex-1"}`} onClick={onDismiss} disabled={busy} aria-busy={busy}>
                {busy && <Spinner className="h-3.5 w-3.5" />} Dismiss
              </button>
            </>
          )}
          <button
            className="rounded-lg p-2 text-neutral-500 transition-colors hover:bg-red-500/10 hover:text-red-300 disabled:opacity-50"
            onClick={onDelete}
            disabled={busy}
            title="Delete snapshot"
            aria-label="Delete snapshot"
          >
            <Icon name="trash" className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function EnrollModal({ snap, onClose, onDone }: { snap: ScanSnapshot; onClose: () => void; onDone: (pendingCount?: number) => void }) {
  const preselectedId = snap.candidate_user_id ?? snap.user_id;
  const preselectedName = snap.candidate_user_id ? snap.candidate_name : snap.user_name;
  const [employee, setEmployee] = useState<PickedEmployee | null>(preselectedId ? { id: preselectedId, full_name: preselectedName ?? "Selected employee" } : null);
  const [busy, setBusy] = useState(false);
  const [needsConsent, setNeedsConsent] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);

  async function submit(consent = false) {
    if (!employee || busy) return;
    setBusy(true);
    setRefused(null);
    try {
      const res = await api.post<{ pending_count?: number }>(`/review/snapshots/${snap.id}/enroll`, { user_id: employee.id, consent });
      toast.success("Sample added", "Recognition will use this photo from now on.");
      onDone(res?.data?.pending_count);
    } catch (err: any) {
      const status = err?.response?.status;
      if (err?.response?.data?.code === "CONSENT_REQUIRED") setNeedsConsent(true);
      else if (status === 409 || status === 422) setRefused(errorMessage(err, "This frame can't be used as a face sample."));
      else toast.error("Couldn't add sample", errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={busy ? () => undefined : onClose}
      title="Add as enrollment sample"
      footer={
        <>
          <button className="btn-ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          {needsConsent ? (
            <button className="btn-primary" onClick={() => submit(true)} disabled={busy || !employee}>
              {busy && <Spinner />} Employee consented — add
            </button>
          ) : (
            <button className="btn-primary" onClick={() => submit()} disabled={busy || !employee || !!refused}>
              {busy && <Spinner />} Add sample
            </button>
          )}
        </>
      }
    >
      <p className="mb-3 text-sm text-neutral-400">
        Only add a frame you have checked by eye. It is rejected automatically if the face doesn't resemble the chosen employee's existing samples, or is already enrolled as someone else.
      </p>
      <EmployeePicker
        excludeRoles={["KIOSK"]}
        value={employee}
        onChange={(u) => {
          setEmployee(u);
          setRefused(null);
          setNeedsConsent(false);
        }}
      />
      {needsConsent && (
        <p role="alert" className="mt-3 rounded-xl border border-orange-400/30 bg-orange-500/10 px-4 py-2.5 text-sm text-orange-200">
          No biometric consent is on file for this employee. Confirm they agreed to face recognition to continue.
        </p>
      )}
      {refused && (
        <p role="alert" className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm text-red-300">
          <b className="block text-red-200">Not added — the server refused this frame.</b>
          {refused}
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
  const [loadingMore, setLoadingMore] = useState(false);
  const [enrolling, setEnrolling] = useState<ScanSnapshot | null>(null);
  const [deleting, setDeleting] = useState<ScanSnapshot | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  // Synchronous mirror of busyIds: a double click lands before React re-renders the disabled button.
  const busyRef = useRef<Set<string>>(new Set());
  const begin = useLatestRequest();

  const load = useCallback(async () => {
    const req = begin();
    setLoading(true);
    setLoadingMore(false);
    try {
      const res = await api.get<ListResponse>("/review/snapshots", { params: { filter, limit: PAGE_SIZE, offset: 0 }, signal: req.signal });
      if (!req.isCurrent()) return;
      setItems(res.data.items);
      setTotal(res.data.total);
      setPending(res.data.pending_count);
    } catch (err) {
      if (!req.isCurrent() || isCancelled(err)) return;
      toast.error("Couldn't load snapshots", errorMessage(err));
    } finally {
      if (req.isCurrent()) setLoading(false);
    }
  }, [filter, begin]);

  useEffect(() => {
    load();
  }, [load]);

  async function loadMore() {
    if (loadingMore) return;
    const req = begin();
    setLoadingMore(true);
    try {
      const res = await api.get<ListResponse>("/review/snapshots", { params: { filter, limit: PAGE_SIZE, offset: items.length }, signal: req.signal });
      if (!req.isCurrent()) return;
      setItems((prev) => {
        const seen = new Set(prev.map((p) => p.id));
        return [...prev, ...res.data.items.filter((i) => !seen.has(i.id))];
      });
      setTotal(res.data.total);
      setPending(res.data.pending_count);
    } catch (err) {
      if (!req.isCurrent() || isCancelled(err)) return;
      toast.error("Couldn't load more snapshots", errorMessage(err));
    } finally {
      if (req.isCurrent()) setLoadingMore(false);
    }
  }

  /** Apply a resolution locally instead of reloading (keeps "load more" pages in place). */
  function resolved(id: string, resolution: "ADDED" | "DISMISSED", pendingCount?: number) {
    if (filter === "pending") {
      setItems((prev) => prev.filter((p) => p.id !== id));
      setTotal((t) => Math.max(0, t - 1));
    } else {
      setItems((prev) => prev.map((p) => (p.id === id ? { ...p, resolution } : p)));
    }
    if (typeof pendingCount === "number") setPending(pendingCount);
    else setPending((n) => Math.max(0, n - 1));
  }

  function setCardBusy(id: string, on: boolean) {
    if (on) busyRef.current.add(id);
    else busyRef.current.delete(id);
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  async function dismiss(s: ScanSnapshot) {
    if (busyRef.current.has(s.id)) return;
    setCardBusy(s.id, true);
    try {
      const res = await api.post<{ pending_count?: number }>(`/review/snapshots/${s.id}/dismiss`);
      resolved(s.id, "DISMISSED", res?.data?.pending_count);
    } catch (err) {
      toast.error("Couldn't dismiss", errorMessage(err));
    } finally {
      setCardBusy(s.id, false);
    }
  }

  async function remove(s: ScanSnapshot) {
    if (deleteBusy || busyRef.current.has(s.id)) return;
    setDeleteBusy(true);
    setCardBusy(s.id, true);
    try {
      const res = await api.delete<{ pending_count?: number }>(`/review/snapshots/${s.id}`);
      setItems((prev) => prev.filter((p) => p.id !== s.id));
      setTotal((t) => Math.max(0, t - 1));
      const wasPending = s.status !== "MATCHED" && !s.resolution;
      if (typeof res?.data?.pending_count === "number") setPending(res.data.pending_count);
      else if (wasPending) setPending((n) => Math.max(0, n - 1));
      setDeleting(null);
    } catch (err) {
      toast.error("Couldn't delete", errorMessage(err));
    } finally {
      setDeleteBusy(false);
      setCardBusy(s.id, false);
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
            type="button"
            aria-pressed={filter === f.key}
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
              <SnapshotCard
                key={s.id}
                snap={s}
                busy={busyIds.has(s.id)}
                onEnroll={() => setEnrolling(s)}
                onDismiss={() => dismiss(s)}
                onDelete={() => setDeleting(s)}
              />
            ))}
          </div>
          <div className="mt-4 flex flex-col items-center gap-2">
            <p className="text-xs text-neutral-500" aria-live="polite">
              Showing {items.length} of {total}
            </p>
            {total > items.length && (
              <button className="btn-ghost py-2 text-xs" onClick={loadMore} disabled={loadingMore || loading}>
                {loadingMore && <Spinner />} Load more
              </button>
            )}
          </div>
        </>
      )}

      {enrolling && (
        <EnrollModal
          snap={enrolling}
          onClose={() => setEnrolling(null)}
          onDone={(pendingCount) => {
            resolved(enrolling.id, "ADDED", pendingCount);
            setEnrolling(null);
          }}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        title="Delete snapshot?"
        danger
        busy={deleteBusy}
        confirmLabel="Delete"
        message="This permanently deletes the saved frame. The attendance record it belongs to is kept."
        onConfirm={() => deleting && remove(deleting)}
        onClose={() => !deleteBusy && setDeleting(null)}
      />
    </>
  );
}
