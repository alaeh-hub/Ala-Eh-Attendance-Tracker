import Icon from "../../components/Icon";
import { glass, noticeStyle } from "./captureStyles";
import type { Notice } from "./poses";

type Readiness = { ready: boolean; score: number; reason: string | null } | null;

/** The instruction (or the latest result) sits above the face window so it never covers the face. */
export default function CaptureBanner({ notice, pose, poseKey, poseNumber, poseCount, readiness }: {
  notice: Notice | null;
  pose: { title: string; hint: string; arrow?: string } | null;
  poseKey: string | undefined;
  poseNumber: number;
  poseCount: number;
  readiness: Readiness;
}) {
  return (
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
          <div key={poseKey} role="status" className={`${glass} w-full max-w-xl overflow-hidden rounded-3xl animate-fade-up`}>
            <div className="flex items-center gap-4 p-3 sm:p-4">
              <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-brand-500 text-3xl font-black text-black sm:h-16 sm:w-16 sm:text-4xl">
                {pose.arrow ?? <Icon name="scan" className="h-8 w-8" strokeWidth={2.2} />}
              </span>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-brand-300">
                  Pose {poseNumber} of {poseCount}
                </p>
                <p className="text-2xl font-extrabold leading-tight text-white sm:text-3xl">{pose.title}</p>
                <p className="text-sm text-neutral-300 [@media(max-height:520px)]:hidden">{readiness && !readiness.ready && readiness.reason ? readiness.reason : pose.hint}</p>
              </div>
              {readiness?.ready && (
                <span className="ml-auto shrink-0 rounded-full bg-emerald-500 px-3 py-1 text-sm font-bold text-black">Ready</span>
              )}
            </div>
            <div className="h-1.5 bg-white/10" aria-hidden="true">
              <div className={`h-full transition-colors duration-200 ${readiness?.ready ? "bg-emerald-400" : "bg-orange-400"}`} style={{ width: `${Math.round((readiness?.score ?? 0) * 100)}%` }} />
            </div>
          </div>
        )
      )}
    </div>
  );
}
