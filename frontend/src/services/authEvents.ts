/**
 * Window events the API layer dispatches so the auth store can follow along.
 * Kept in their own module (no imports) so tests that mock services/api still
 * get the real names.
 */
export const SESSION_EVENT = "auth:session"; // CustomEvent<SessionPayload>: a refresh produced a new session
export const EXPIRED_EVENT = "auth:expired"; // the session is gone (refresh rejected with 401/422)
export const KIOSK_LOCKED_EVENT = "auth:kiosk-locked"; // the server says this session is kiosk-locked
