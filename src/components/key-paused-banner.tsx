import Link from "next/link";
import { BYOK_NO_CREDIT } from "@/lib/byok-credit";

// CHE-458: above every signed-in page while the team's own OpenRouter key cannot
// pay. One sentence, and the way to the key.
export function KeyPausedBanner() {
  return (
    <div role="status" className="mx-auto mt-6 w-full max-w-6xl px-4">
      <p className="rounded-lg border border-status-broken/40 bg-status-broken/10 px-4 py-2.5 text-sm text-status-broken">
        {BYOK_NO_CREDIT}{" "}
        <Link href="/settings/team" className="underline hover:no-underline">
          The team&apos;s key
        </Link>
      </p>
    </div>
  );
}
