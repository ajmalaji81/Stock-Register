// Profile pictures are stored as small data: URLs in the database (no file storage needed).
// The browser crops + resizes to 256x256 JPEG before upload, so a real avatar is ~10-40 KB.
// Pure (no imports) so it can be unit-tested and used by the browser.

export const AVATAR_SIZE = 256;
/** Hard cap on the stored string (~110 KB of image data). */
export const AVATAR_MAX_CHARS = 150_000;

const DATA_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Returns an error message, or null if the value is an acceptable avatar data URL. */
export function avatarError(value: string): string | null {
  if (value.length > AVATAR_MAX_CHARS) return "Picture is too large. Please choose a smaller image.";
  if (!DATA_URL.test(value)) return "Picture must be a PNG, JPEG or WebP image.";
  return null;
}
