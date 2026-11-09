/** The kiosk's punch selection and its device identity. */

export type StatusOverride = "AUTO" | "AM_IN" | "AM_OUT" | "PM_IN" | "PM_OUT" | "OT_IN" | "OT_OUT";

/**
 * What the employee picks is only a hint: the server decides the punch that
 * is actually recorded and tells us when it overruled the selection (see
 * `corrected` on the response), so a wrong tap can't write a wrong record.
 * The kiosk picks a direction (in / out) and, when one is chosen, which part
 * of the day it belongs to; with nothing chosen it stays on Auto.
 */
/** Maps a kiosk selector choice to the (event_type, session) the API expects. */
export function overridePunch(status: StatusOverride): { event_type?: "CLOCK_IN" | "CLOCK_OUT"; session?: "AM" | "PM" | "OT" } {
  if (status === "AUTO") return {};
  const [session, direction] = status.split("_") as ["AM" | "PM" | "OT", "IN" | "OUT"];
  return { event_type: direction === "IN" ? "CLOCK_IN" : "CLOCK_OUT", session };
}

export function deviceId() {
  try {
    let id = localStorage.getItem("kiosk_device_id");
    if (!id) {
      id = `kiosk-${Math.random().toString(36).slice(2, 8)}`;
      localStorage.setItem("kiosk_device_id", id);
    }
    return id;
  } catch {
    return "kiosk";
  }
}
