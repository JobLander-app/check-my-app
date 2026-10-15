// CHE-448: what the Team page says about the team's model key, in one pure
// module so its words are checked (scripts/verify-byok.ts runs them through
// the verdict-language guards). It states the key's status; it never tells the
// team what to do about it.

import { BYOK_NO_CREDIT } from "@/lib/byok-credit";

export type StoredKey = { masked: string } | { unreadable: true } | null;

export function keyStatusLine(stored: StoredKey, noCredit = false): { text: string; tone: "normal" | "broken" } {
  // CHE-458: a key that cannot pay is the first thing said about it.
  if (stored && "masked" in stored && noCredit) {
    return { text: `${BYOK_NO_CREDIT} The key is ${stored.masked}.`, tone: "broken" };
  }
  if (!stored) {
    return {
      text: "No key yet. With the team's own OpenRouter key, checks run on it: the model is paid from that OpenRouter account, and checks cost the team nothing here.",
      tone: "normal",
    };
  }
  if ("unreadable" in stored) {
    return { text: "The team's key can no longer be used, so checks cannot run on it.", tone: "broken" };
  }
  return {
    text: `Checks of this team run on the team's own OpenRouter key ${stored.masked}. The model is paid from that OpenRouter account, and checks cost the team nothing here.`,
    tone: "normal",
  };
}

export const ONLY_ADMINS = "Only an admin of this team adds or changes the key.";
