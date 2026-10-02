// The small copy of a step screenshot, made on first request (CHE-362).
//
// Kept apart from the route so the rules are testable without a Worker
// (scripts/verify-journeys-page.ts): a screenshot is resized once and the copy
// is served from the store ever after; when the copy cannot be made — no
// resizer bound, the resize failed, the month's allowance is used up — the
// reader gets the original, never a broken frame; and a thumbnail of a
// screenshot we do not hold does not exist.
//
// The store and the resizer are named by what this file needs of them, so R2
// and the Images binding fit as they are and a test can stand in for both.

import { THUMB_WIDTH } from "./storage";

interface StoredObject {
  body: ReadableStream<Uint8Array>;
  httpEtag?: string;
  httpMetadata?: { contentType?: string };
}

export interface ThumbStore {
  get(key: string): Promise<StoredObject | null>;
  put(key: string, body: ArrayBuffer, options: { httpMetadata: { contentType: string } }): Promise<unknown>;
}

export interface ThumbResizer {
  input(stream: ReadableStream<Uint8Array>): {
    transform(transform: { width: number }): {
      output(options: { format: "image/webp"; quality: number }): Promise<{ image(): ReadableStream<Uint8Array> }>;
    };
  };
}

export interface ThumbAnswer {
  body: ReadableStream<Uint8Array> | ArrayBuffer;
  contentType: string;
  // "thumb" is the small copy and never changes; "original" is the stand-in
  // for a copy we could not make, and must not be remembered as the copy.
  kind: "thumb" | "original";
  etag?: string;
}

const WEBP = "image/webp";
const QUALITY = 75;

export async function thumbnail(args: {
  store: ThumbStore;
  resizer: ThumbResizer | null;
  thumbKey: string;
  screenshotKey: string;
  // Work that may finish after the answer is sent (the route's waitUntil).
  keep: (work: Promise<unknown>) => void;
}): Promise<ThumbAnswer | null> {
  const { store, resizer, thumbKey, screenshotKey, keep } = args;
  const made = await store.get(thumbKey);
  if (made) return { body: made.body, contentType: WEBP, kind: "thumb", etag: made.httpEtag };

  const source = await store.get(screenshotKey);
  if (!source) return null;
  const original = await new Response(source.body).arrayBuffer();
  const fallback: ThumbAnswer = {
    body: original,
    contentType: source.httpMetadata?.contentType ?? "image/png",
    kind: "original",
  };
  if (!resizer) return fallback;

  try {
    const result = await resizer
      .input(new Response(original).body!)
      .transform({ width: THUMB_WIDTH })
      .output({ format: WEBP, quality: QUALITY });
    const small = await new Response(result.image()).arrayBuffer();
    if (small.byteLength === 0) throw new Error("the resizer returned nothing");
    keep(
      store.put(thumbKey, small, { httpMetadata: { contentType: WEBP } }).catch((err) => {
        // Not stored: the next request resizes again. Worth knowing, not worth failing.
        console.error("thumbnail: could not store", thumbKey, err instanceof Error ? err.message : err);
      }),
    );
    return { body: small, contentType: WEBP, kind: "thumb" };
  } catch (err) {
    console.error("thumbnail: could not resize", screenshotKey, err instanceof Error ? err.message : err);
    return fallback;
  }
}
