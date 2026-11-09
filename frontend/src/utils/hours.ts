/** Hours as "7h 05m" (fractional hours in, minutes rounded; 7.999 rolls over to 8h 00m). */
export function hoursLabel(h: number): string {
  let hh = Math.floor(h);
  let mm = Math.round((h - hh) * 60);
  if (mm === 60) {
    hh += 1;
    mm = 0;
  }
  return `${hh}h ${String(mm).padStart(2, "0")}m`;
}
