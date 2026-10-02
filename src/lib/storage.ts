// Evidence/artifact storage on Cloudflare R2 (CHE-12).
//
// One module shared by both planes: the agent worker PUTs screenshots,
// transcripts and generated specs; the web app's /api/evidence/[...path] route
// GETs them. Keys are content-addressed (sha256) or run-scoped, so the
// unguessable key + the private verdict permalink are the MVP access boundary —
// the bucket stays private and is proxied through the Worker (no public URLs).
// Real signed URLs / per-tenant ACLs are post-MVP.

export const EVIDENCE_PATH_PREFIX = "/api/evidence/";

export function evidenceUrl(key: string): string {
  return EVIDENCE_PATH_PREFIX + key.replace(/^\/+/, "");
}

// The inverse: the R2 key behind a stored evidence URL, or null when the URL
// is not ours (an external link, an absolute URL from an older deployment).
export function evidenceKey(url: string | null | undefined): string | null {
  if (!url || !url.startsWith(EVIDENCE_PATH_PREFIX)) return null;
  const key = url.slice(EVIDENCE_PATH_PREFIX.length);
  return key.length > 0 ? key : null;
}

// A small copy of a step screenshot (CHE-362). A screenshot is ~420 KB as
// stored; a page that shows every journey of an app as a strip of its frames
// would weigh 20–30 MB, and the same frame at 480px is ~6 KB. The copy is made
// on first request by /api/evidence/[...path] and kept beside the original
// under the same content hash, so one screenshot is resized once, ever.
//
// One width, on purpose: the width is part of the address, and an address
// anyone can vary is a way to make us resize without end.
export const THUMB_WIDTH = 480;

const SCREENSHOT_KEY = /^screenshots\/([0-9a-f]{64})\.png$/;
const THUMB_KEY = new RegExp(`^thumbs/${THUMB_WIDTH}/([0-9a-f]{64})\\.webp$`);

// The thumbnail's key for a screenshot's key; null for anything that is not a
// content-addressed screenshot (a video, a transcript, an older absolute URL).
export function thumbKeyOf(screenshotKey: string): string | null {
  const hash = SCREENSHOT_KEY.exec(screenshotKey)?.[1];
  return hash ? `thumbs/${THUMB_WIDTH}/${hash}.webp` : null;
}

// …and back: the screenshot a thumbnail key is a copy of.
export function screenshotKeyOfThumb(thumbKey: string): string | null {
  const hash = THUMB_KEY.exec(thumbKey)?.[1];
  return hash ? `screenshots/${hash}.png` : null;
}

// What a page puts in `src` for a small frame: the thumbnail's address when
// the stored URL is one of our screenshots, the stored URL itself otherwise.
export function thumbUrl(screenshotUrl: string): string {
  const key = evidenceKey(screenshotUrl);
  const thumb = key ? thumbKeyOf(key) : null;
  return thumb ? evidenceUrl(thumb) : screenshotUrl;
}

const CONTENT_TYPES: Record<string, string> = {
  webp: "image/webp",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webm: "video/webm",
  json: "application/json",
  ts: "text/plain; charset=utf-8",
  har: "application/json",
  txt: "text/plain; charset=utf-8",
};

export function contentTypeFor(key: string): string {
  const ext = key.split(".").pop()?.toLowerCase() ?? "";
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

// Store an object and return the web path the frontend links/renders.
export async function putObject(
  bucket: R2Bucket,
  key: string,
  body: ArrayBuffer | Uint8Array | string,
): Promise<string> {
  await bucket.put(key, body, {
    httpMetadata: { contentType: contentTypeFor(key) },
  });
  return evidenceUrl(key);
}

export async function getObject(bucket: R2Bucket, key: string): Promise<R2ObjectBody | null> {
  return bucket.get(key);
}

// R2 accepts up to 1000 keys per delete call.
const DELETE_BATCH = 1000;

// Remove objects. The caller decides that nothing references the keys any more
// (screenshots are content-addressed and may be shared between runs — see
// src/lib/ephemeral.ts); this only does the deleting, in batches.
export async function deleteObjects(bucket: R2Bucket, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += DELETE_BATCH) {
    await bucket.delete(keys.slice(i, i + DELETE_BATCH));
  }
}
