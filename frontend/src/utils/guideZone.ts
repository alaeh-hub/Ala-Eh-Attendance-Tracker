/**
 * Where the on-screen face window sits in the camera frame, as fractions of
 * the frame. The video fills the screen cropped (object-cover) and mirrored,
 * so the window's screen position has to be mapped back through both. The
 * server only scans faces inside this area. Returns null when it can't be
 * measured, in which case the server scans the whole frame as before.
 */
export function guideZone(video: HTMLVideoElement | null, oval: HTMLElement | null) {
  if (!video || !oval || !video.videoWidth || !video.videoHeight) return null;
  const v = video.getBoundingClientRect();
  const o = oval.getBoundingClientRect();
  if (!v.width || !v.height || !o.width || !o.height) return null;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const scale = Math.max(v.width / vw, v.height / vh);
  const offsetX = (v.width - vw * scale) / 2;
  const offsetY = (v.height - vh * scale) / 2;
  const screenX = o.left + o.width / 2 - v.left;
  const screenY = o.top + o.height / 2 - v.top;
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  return {
    cx: clamp((v.width - screenX - offsetX) / scale / vw), // mirrored: screen-left is frame-right
    cy: clamp((screenY - offsetY) / scale / vh),
    rx: o.width / 2 / scale / vw,
    ry: o.height / 2 / scale / vh,
  };
}
