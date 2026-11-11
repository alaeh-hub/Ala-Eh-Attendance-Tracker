import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Mascot } from "page-mascot";
import { Socket, io } from "socket.io-client";
import Icon from "../../components/Icon";
import { UnderlineLink } from "../../components/fx/UnderlineLink";
import { Avatar, Banner, EmptyState, EventBadge, PageHeader, Segmented, StatCard, formatDateTime, formatTime, timeAgo } from "../../components/ui";
import api, { SOCKET_URL, getAccessToken, isAuthFailure, refreshOrExpire } from "../../services/api";
import { formatDate, orgNow, useOrgStore } from "../../utils/orgTime";
import type { AttendanceEvent, TodayReport } from "../../types";

// The same in/out pair as the kiosk and the badges (--color-in green, --color-out blue): bright enough on the dark
// panel (both above 4.5:1 against #141414) and separable for colour-blind viewers; the legend and tooltip repeat the names.
const SERIES = [
  { key: "clock_in", label: "Clock in", color: "var(--chart-in)" },
  { key: "clock_out", label: "Clock out", color: "var(--chart-out)" },
] as const;

function hourLabel(h: number) {
  const suffix = h < 12 ? "a" : "p";
  return `${h % 12 === 0 ? 12 : h % 12}${suffix}`;
}

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="pop px-3 py-2 text-xs">
      <p className="mb-1 font-semibold text-white">
        {hourLabel(label)}m – {hourLabel((label + 1) % 24)}m
      </p>
      {payload.map((p: any) => (
        <p key={p.dataKey} className="flex items-center gap-2 text-neutral-300">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: p.color }} />
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
  const [conn, setConn] = useState<"connecting" | "live" | "reconnecting">("connecting");
  useOrgStore((s) => s.timeZone); // re-render dates when the org timezone arrives
  const [flashId, setFlashId] = useState<string | null>(null);
  const [feedFilter, setFeedFilter] = useState<"all" | "in" | "out" | "late">("all");
  const flashTimer = useRef<ReturnType<typeof setTimeout>>();
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
    let socket: Socket | undefined;
    let closed = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    // React Strict Mode runs an extra setup/cleanup cycle in development.
    // Defer connecting so that cycle can cancel before opening a WebSocket.
    const connectTimer = setTimeout(() => {
      const options = {
        // A callback, so every (re)connect sends the current in-memory access token.
        auth: (cb: (data: object) => void) => cb({ token: getAccessToken() }),
        transports: ["websocket", "polling"],
      };
      // Same origin as the page unless the API lives on another origin.
      socket = SOCKET_URL ? io(SOCKET_URL, options) : io(options);
      const s = socket;
      s.on("connect", () => {
        failures = 0;
        setConn("live");
      });
      s.on("disconnect", () => setConn("reconnecting"));
      s.on("connect_error", async () => {
        setConn("reconnecting");
        // socket.io retries transport errors on its own; a rejected handshake
        // (usually an expired access token) leaves it inactive. Refresh the
        // token, then reconnect with backoff.
        if (s.active || closed) return;
        failures += 1;
        try {
          await refreshOrExpire();
        } catch (err) {
          if (isAuthFailure(err)) return; // signed out: the app returns to the sign-in page
        }
        if (closed) return;
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => !closed && s.connect(), Math.min(30_000, 1000 * 2 ** Math.min(failures - 1, 5)));
      });
      s.on("attendance_event", (event: AttendanceEvent) => {
        setEvents((prev) => [event, ...prev.filter((p) => p.id !== event.id)].slice(0, 30));
        setFlashId(event.id);
        clearTimeout(flashTimer.current);
        flashTimer.current = setTimeout(() => setFlashId(null), 3000); // the highlight fades after a moment
        clearTimeout(refreshTimer.current);
        refreshTimer.current = setTimeout(load, 400); // debounce stat refresh
      });
    }, 0);
    return () => {
      closed = true;
      clearInterval(poll);
      clearTimeout(connectTimer);
      clearTimeout(retryTimer);
      clearTimeout(refreshTimer.current);
      clearTimeout(flashTimer.current);
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

  const feed = useMemo(
    () => events.filter((e) => (feedFilter === "all" ? true : feedFilter === "in" ? e.event_type === "CLOCK_IN" : feedFilter === "out" ? e.event_type === "CLOCK_OUT" : e.is_late)),
    [events, feedFilter]
  );

  const attendanceRate = report && report.total_employees ? Math.round((report.present / report.total_employees) * 100) : 0;
  const today = formatDate(report?.date ?? orgNow(), { weekday: "long", month: "long", day: "numeric", year: "numeric" });

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
            <Link to="/kiosk" className="btn-primary">
              <Icon name="scan" className="h-4 w-4" /> Open kiosk
            </Link>
          </>
        }
      />

      {error && (
        <Banner tone="error" className="mb-5">{error}</Banner>
      )}

      <div className="grid grid-cols-2 gap-x-4 gap-y-5 lg:grid-cols-4">
        <StatCard label="Present today" accent loading={loading} value={report?.present ?? 0} hint={report ? `${attendanceRate}% of ${report.total_employees} employees` : undefined} delay={0} />
        <StatCard label="On site now" loading={loading} value={report?.currently_in ?? 0} hint="Clocked in, not yet out" delay={60} />
        <StatCard label="Late arrivals" loading={loading} value={report?.late ?? 0} hint="First clock-in after shift start" delay={120} />
        <StatCard label="Not yet in" loading={loading} value={report?.absent ?? 0} hint={report ? `${report.enrolled} of ${report.total_employees} enrolled` : undefined} delay={180} />
      </div>

      <div className="mt-5 grid gap-5 sm:mt-6 sm:gap-6 xl:grid-cols-[1.6fr_1fr]">
        <section className="panel min-w-0 py-5">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-bold text-white">Activity by hour</h2>
              <p className="text-xs text-neutral-400">{report?.events_today ?? 0} scans today · {report?.timezone}</p>
            </div>
            <div className="flex items-center gap-3 text-xs text-neutral-300 sm:gap-4" aria-label="Legend">
              {SERIES.map((s) => (
                <span key={s.key} className="flex items-center gap-1.5">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
                  {s.label}
                </span>
              ))}
            </div>
          </div>
          <div className="h-56 sm:h-72">
            {loading ? (
              <div className="skeleton h-full w-full" />
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={hourly} barGap={2} barCategoryGap="22%" margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="var(--color-rule)" />
                  <XAxis dataKey="hour" tickFormatter={hourLabel} tick={{ fill: "var(--color-muted)", fontSize: 12 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                  <YAxis allowDecimals={false} tick={{ fill: "var(--color-muted)", fontSize: 12 }} axisLine={false} tickLine={false} />
                  <Tooltip content={<ChartTooltip />} cursor={{ fill: "rgb(var(--ch-white) / 0.05)" }} />
                  {SERIES.map((s) => (
                    <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[4, 4, 0, 0]} maxBarSize={18} animationDuration={700} />
                  ))}
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
          {/* Accessible table view of the chart */}
          <div className="sr-only">
          <table>
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
          </div>

        </section>

        <section className="panel flex min-w-0 flex-col xl:h-0 xl:min-h-full">
          <div className="flex items-center justify-between border-b border-white/[0.06] px-3 py-3 sm:px-5 sm:py-4">
            <h2 className="font-bold text-white">Live feed</h2>
            <UnderlineLink to="/records" className="text-xs font-semibold text-brand-400">
              View all
            </UnderlineLink>
          </div>
          <div className="border-b border-[var(--color-rule)] px-3 py-2 sm:px-5">
            <Segmented
              label="Filter the live feed"
              options={[{ key: "all", label: "All" }, { key: "in", label: "In" }, { key: "out", label: "Out" }, { key: "late", label: "Late" }]}
              value={feedFilter}
              onChange={setFeedFilter}
            />
          </div>
          <div className="max-h-[70dvh] flex-1 overflow-y-auto overscroll-contain p-1 sm:max-h-[560px] sm:p-2 xl:max-h-none">
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
            {!loading && events.length > 0 && feed.length === 0 && <p className="p-5 text-center text-sm text-neutral-400">No matching scans in the latest {events.length}.</p>}
            {feed.map((e) => (
              <div
                key={e.id}
                className={`reveal-item flex items-center gap-2.5 border-b border-[var(--color-rule)] p-2.5 transition-colors duration-700 last:border-b-0 hover:bg-white/[0.03] sm:gap-3 sm:p-3 ${flashId === e.id ? "bg-brand-500/10" : ""}`}
              >
                <Avatar userId={e.user_id} name={e.user_name} hasPhoto={e.has_photo} size="h-9 w-9 sm:h-10 sm:w-10" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-white">{e.user_name ?? "Unknown"}</p>
                  <p className="truncate text-xs text-neutral-400">
                    {[e.employee_code, e.department].filter(Boolean).join(" · ") || "—"}
                  </p>
                </div>
                <div className="flex max-w-[52%] shrink-0 flex-col items-end gap-1 sm:max-w-none">
                  <EventBadge type={e.event_type} session={e.session} late={e.is_late} lateMinutes={e.late_minutes} earlyMinutes={e.early_minutes} />
                  <span className="text-xs tabular-nums text-neutral-400" title={formatDateTime(e.timestamp)}>
                    {formatTime(e.timestamp)} · {timeAgo(e.timestamp)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {report && report.departments.length > 0 && (
        <section className="panel mt-5 min-w-0 py-5 sm:mt-6">
          <h2 className="mb-4 font-bold text-white">Attendance by department</h2>
          <div className="grid gap-x-8 gap-y-3 md:grid-cols-2">
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
                    <div data-grow className="h-full rounded-full bg-brand-500" style={{ width: `${pct}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </>
  );
}
