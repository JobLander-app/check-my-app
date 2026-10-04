import { NextResponse } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { contentTypeFor, getObject, screenshotKeyOfThumb } from "@/lib/storage";
import { thumbnail } from "@/lib/thumbnail";

// GET /api/evidence/{key...} — serve evidence (screenshots, transcripts,
// generated specs) from the private R2 bucket. Keys are content-addressed
// (sha256) or run-scoped; the verdict permalink is unguessable, so proxying
// through the Worker is the MVP access boundary. Post-MVP: signed URLs / ACLs.

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ path: string[] }> }) {
  const key = (await params).path.join("/");
  // Native popup masking missed a selected resume filename in the live feed.
  // Raw extension images and diagnostics stay private, including older keys.
  if (key.startsWith("private/") || key.startsWith("extensions/")) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { env, ctx } = getCloudflareContext();
  const bucket = (env as unknown as { EVIDENCE?: R2Bucket }).EVIDENCE;
  if (!bucket) return NextResponse.json({ error: "Storage unavailable" }, { status: 503 });

  // CHE-362: the small copy of a screenshot, made the first time it is asked
  // for (src/lib/thumbnail.ts). The original stands in when it cannot be made,
  // with a short cache so the stand-in is not what a browser keeps for a year.
  const screenshotKey = screenshotKeyOfThumb(key);
  if (screenshotKey) {
    const answer = await thumbnail({
      store: bucket,
      resizer: (env as unknown as { IMAGES?: ImagesBinding }).IMAGES ?? null,
      thumbKey: key,
      screenshotKey,
      keep: (work) => ctx.waitUntil(work),
    });
    if (!answer) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return new Response(answer.body, {
      headers: {
        "Content-Type": answer.contentType,
        "Cache-Control": answer.kind === "thumb" ? "private, max-age=31536000, immutable" : "private, max-age=300",
        ...(answer.etag ? { ETag: answer.etag } : {}),
      },
    });
  }

  const object = await getObject(bucket, key);
  if (!object) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? contentTypeFor(key),
      "Cache-Control": "private, max-age=31536000, immutable",
      ...(object.httpEtag ? { ETag: object.httpEtag } : {}),
    },
  });
}
