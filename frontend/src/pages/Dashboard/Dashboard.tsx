import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Mascot } from "page-mascot";
import { io } from "socket.io-client";
import Icon from "../../components/Icon";
import { Avatar, EmptyState, EventBadge, PageHeader, StatCard, formatTime, timeAgo } from "../../components/ui";
import api, { SOCKET_URL } from "../../services/api";
import type { AttendanceEvent, TodayReport } from "../../types";

// Validated (dataviz validate_palette.js, dark mode on #141414): in-band
// lightness, CVD-separable. Clock-in = brand gold, clock-out = blue.
const SERIES = [
  { key: "clock_in", label: "Clock in", color: "#B48A00" },
  { key: "clock_out", label: "Clock out", color: "#5B7CF0" },
] as const;

function hourLabel(h: number) {
  const suffix = h < 12 ? "a" : "p";
  return `${h % 12 === 0 ? 12 : h % 12}${suffix}`;
}

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-white/10 bg-ink-850/95 px-3 py-2 text-xs shadow-2xl backdrop-blur">
      <p className="mb-1 font-semibold text-white">
        {hourLabel(label)}m – {hourLabel((label + 1) % 24)}m
      </p>
      {payload.map((p: any) => (
        <p key={p.dataKey} className="flex items-center gap-2 text-neutral-300">
          <span className="h-2 w-2 rounded-sm" style={{ background: p.color }} />
          {p.name}: <span className="font-semibold tabular-nums text-white">{p.value}</span>
        </p>
      ))}
    </div>
  );
}

export default function Dashboard() {
  const [report, setReport] = useState<TodayReport | null>(null);
  const [events, setEvents] = useState<AttendanceEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [flashId, setFlashId] = useState<string | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>();

  const load = useCallback(async () => {
    try {
      const [r, e] = await Promise.all([api.get<TodayReport>("/reports/today"), api.get<AttendanceEvent[]>("/attendance", { params: { limit: 30 } })]);
      setReport(r.data);
      setEvents(e.data);
      setError(null);
    } catch {
      setError("Couldn't load today's attendance. Retrying shortly…");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const poll = setInterval(load, 60_000);
    let socket: ReturnType<typeof io> | undefined;
    // React Strict Mode runs an extra setup/cleanup cycle in development.
    // Defer connecting so that cycle can cancel before opening a WebSocket.
    const connectTimer = setTimeout(() => {
      socket = io(SOCKET_URL, { auth: { token: localStorage.getItem("access_token") }, transports: ["websocket", "polling"] });
      socket.on("connect", () => setConnected(true));
      socket.on("disconnect", () => setConnected(false));
      socket.on("attendance_event", (event: AttendanceEvent) => {
        setEvents((prev) => [event, ...prev.filter((p) => p.id !== event.id)].slice(0, 30));
        setFlashId(event.id);
        clearTimeout(refreshTimer.current);
        refreshTimer.current = setTimeout(load, 400); // debounce stat refresh
      });
    }, 0);
    return () => {
      clearInterval(poll);
      clearTimeout(connectTimer);
      clearTimeout(refreshTimer.current);
      socket?.disconnect();
    };
  }, [load]);

  const hourly = useMemo(() => {
    if (!report) return [];
    const active = report.hourly.filter((h) => h.clock_in + h.clock_out > 0).map((h) => h.hour);
    const from = Math.min(6, ...active);
    const to = Math.max(20, ...active);
    return report.hourly.filter((h) => h.hour >= from && h.hour <= to);
  }, [report]);

  const attendanceRate = report && report.total_employees ? Math.round((report.present / report.total_employees) * 100) : 0;
  const today = new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" });

  return (
    <>
      <PageHeader
        title="Today at a glance"
        subtitle={today}
        leading={
          <Mascot
            directions="/mascots/chef-directions.webp"
            reactions="/mascots/chef-reactions.webp"
            size={72}
            label="Ala Eh chef mascot"
            className="hidden shrink-0 sm:block"
          />
        }
        actions={
          <>
            <span className={`chip py-1.5 ${connected ? "bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/25" : "bg-orange-500/10 text-orange-300 ring-1 ring-orange-500/25"}`}>
              <span className={`h-2 w-2 rounded-full ${connected ? "bg-emerald-400 animate-pulse" : "bg-orange-400"}`} />
              {connected ? "Live" : "Reconnecting"}
            </span>
            <Link to="/kiosk" className="btn-primary">
              <Icon name="scan" className="h-4 w-4" /> Open kiosk
            </Link>
          </>
        }
      />

      {error && (
        <div role="alert" className="mb-5 flex items-center gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          <Icon name="alert" className="h-4 w-4" /> {error}
        </div>
      )}

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard label="Present today" accent loading={loading} value={report?.present ?? 0} hint={report ? `${attendanceRate}% of ${report.total_employees} employees` : undefined} delay={0} />
        <StatCard label="On site now" loading={loading} value={report?.currently_in ?? 0} hint="Clocked in, not yet out" delay={60} />
        <StatCard label="Late arrivals" loading={loading} value={report?.late ?? 0} hint="First clock-in after shift start" delay={120} />
        <StatCard label="Not yet in" loading={loading} value={report?.absent ?? 0} hint={report ? `${report.enrolled} of ${report.total_employees} enrolled` : undefined} delay={180} />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1.6fr_1fr]">
        <section className="card min-w-0 p-5 animate-fade-up" style={{ animationDelay: "200ms" }}>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-bold text-white">Activity by hour</h2>
              <p className="text-xs text-neutral-500">{report?.events_today ?? 0} scans today · {report?.timezone}</p>
            </div>
            <div className="flex items-center gap-4 text-xs text-neutral-300" aria-label="Legend">
              {SERIES.map((s) => (
                <span key={s.key} className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
                  {s.label}
                </span>
              ))}
            </div>
          </div>
          <div className="h-64">
            {loading ? (
              <div className="skeleton h-full w-full" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={hourly} barGap={2} barCategoryGap="22%" margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="rgba(255,255,255,.06)" />
                  <XAxis dataKey="hour" tickFormatter={hourLabel} tick={{ fill: "#8a8a8a", fontSize: 11 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                  <YAxis allowDecimals={false} tick={{ fill: "#8a8a8a", fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(255,255,255,.04)" }} />
                  {SERIES.map((s) => (
                    <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[4, 4, 0, 0]} maxBarSize={18} animationDuration={700} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
          {/* Accessible table view of the chart */}
          <table className="sr-only">
            <caption>Scans per hour today</caption>
            <thead>
              <tr><th>Hour</th><th>Clock in</th><th>Clock out</th></tr>
            </thead>
            <tbody>
              {hourly.map((h) => (
                <tr key={h.hour}><td>{hourLabel(h.hour)}</td><td>{h.clock_in}</td><td>{h.clock_out}</td></tr>
              ))}
            </tbody>
          </table>

          {report && report.departments.length > 0 && (
            <div className="mt-6 border-t border-white/[0.06] pt-5">
              <h3 className="mb-3 text-sm font-semibold text-neutral-300">Attendance by department</h3>
              <div className="space-y-3">
                {report.departments.map((d) => {
                  const pct = d.total ? Math.round((d.present / d.total) * 100) : 0;
                  return (
                    <div key={d.department}>
                      <div className="mb-1 flex justify-between text-xs">
                        <span className="text-neutral-300">{d.department}</span>
                        <span className="tabular-nums text-neutral-400">
                          {d.present}/{d.total} · {pct}%
                        </span>
                      </div>
                      <div className="h-2 overflow-hidden rounded-full bg-white/[0.06]">
                        <div className="h-full rounded-full bg-gradient-to-r from-brand-600 to-brand-400 transition-all duration-700" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </section>

        <section className="card flex min-w-0 flex-col animate-fade-up" style={{ animationDelay: "260ms" }}>
          <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
            <h2 className="font-bold text-white">Live feed</h2>
            <Link to="/records" className="text-xs font-semibold text-brand-400 hover:text-brand-300">
              View all →
            </Link>
          </div>
          <div className="max-h-[560px] flex-1 overflow-y-auto p-2">
            {loading &&
              Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 p-3">
                  <div className="skeleton h-10 w-10 rounded-full" />
                  <div className="flex-1 space-y-2">
                    <div className="skeleton h-3 w-32" />
                    <div className="skeleton h-3 w-20" />
                  </div>
                </div>
              ))}
            {!loading && events.length === 0 && <EmptyState icon="scan" title="No scans yet today" message="Check-ins from the kiosk appear here instantly." />}
            {events.map((e) => (
              <div
                key={e.id}
                className={`flex items-center gap-3 rounded-xl p-3 transition-colors duration-700 hover:bg-white/[0.03] ${flashId === e.id ? "bg-brand-500/10 animate-slide-in" : ""}`}
              >
                <Avatar userId={e.user_id} name={e.user_name} hasPhoto={e.has_photo} size="h-10 w-10" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-white">{e.user_name ?? "Unknown"}</p>
                  <p className="truncate text-xs text-neutral-500">
                    {[e.employee_code, e.department].filter(Boolean).join(" · ") || "—"}
                  </p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <EventBadge type={e.event_type} session={e.session} late={e.is_late} lateMinutes={e.late_minutes} earlyMinutes={e.early_minutes} />
                  <span className="text-[11px] tabular-nums text-neutral-500" title={new Date(e.timestamp).toLocaleString()}>
                    {formatTime(e.timestamp)} · {timeAgo(e.timestamp)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </>
  );
}
