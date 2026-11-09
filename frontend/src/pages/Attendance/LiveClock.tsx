import { useEffect, useState } from "react";
import { formatDate, formatTime as formatOrgTime, orgNow, orgParts, useOrgStore } from "../../utils/orgTime";

export default function LiveClock() {
  const [now, setNow] = useState(orgNow);
  useOrgStore((st) => st.timeZone); // re-render when the org timezone arrives
  useEffect(() => {
    const t = setInterval(() => setNow(orgNow()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="min-w-0">
      <p className="whitespace-nowrap text-4xl font-extrabold tabular-nums leading-none tracking-tight text-white drop-shadow sm:text-6xl lg:text-7xl [@media(max-height:520px)]:!text-4xl">
        {formatOrgTime(now.toISOString())}
        <span className="ml-1.5 hidden text-2xl text-brand-400 sm:inline sm:text-3xl lg:text-4xl [@media(max-height:520px)]:!hidden">{String(orgParts(now).second).padStart(2, "0")}</span>
      </p>
      <p className="mt-1 truncate text-sm font-semibold text-neutral-100 drop-shadow sm:text-base lg:text-xl">{formatDate(now, { weekday: "long", month: "long", day: "numeric" })}</p>
    </div>
  );
}
