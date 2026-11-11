import api from "../services/api";

// Photos need the auth header, so they're fetched as blobs and cached per
// session as object URLs. The cache is an LRU (Map keeps insertion order;
// a hit is moved to the end) so a long-running kiosk doesn't grow forever.
const PHOTO_CACHE_LIMIT = 200;
const photoCache = new Map<string, Promise<string | null>>();

function revokeWhenReady(entry: Promise<string | null> | undefined) {
  entry?.then((url) => url && URL.revokeObjectURL(url)).catch(() => undefined);
}

export function forgetPhoto(userId: string) {
  revokeWhenReady(photoCache.get(userId));
  photoCache.delete(userId);
}

/** Drops every cached photo (called on sign-out so the next user can't see them). */
export function clearPhotoCache() {
  photoCache.forEach((entry) => revokeWhenReady(entry));
  photoCache.clear();
}

/** Number of cached photos (for tests). */
export function photoCacheSize() {
  return photoCache.size;
}

export function loadPhoto(userId: string) {
  const hit = photoCache.get(userId);
  if (hit) {
    photoCache.delete(userId);
    photoCache.set(userId, hit);
    return hit;
  }
  const entry: Promise<string | null> = api
    .get(`/users/${userId}/photo`, { responseType: "blob" })
    .then((res) => {
      const url = URL.createObjectURL(res.data);
      // Evicted (or forgotten) while loading: don't leak the URL.
      if (photoCache.get(userId) !== entry) {
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
      return url;
    })
    .catch(() => {
      // Don't cache failures, so a transient error doesn't hide the photo for the whole session.
      if (photoCache.get(userId) === entry) photoCache.delete(userId);
      return null;
    });
  photoCache.set(userId, entry);
  while (photoCache.size > PHOTO_CACHE_LIMIT) {
    const oldest = photoCache.keys().next().value as string;
    forgetPhoto(oldest);
  }
  return entry;
}
