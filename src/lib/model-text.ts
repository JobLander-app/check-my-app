// What a model wrote, with its own escaping taken off (CHE-402).
//
// The models that walk an app sometimes write "&" as "&amp;" — in a tool
// call's input and in the words of a step alike. The page was read correctly
// (`BUTTONS: "Add login & notes (optional)"`); the model then asked to click
// `"Add login &amp; notes (optional)"`. Two things followed, seen in run #298:
// the click found no button of that name and was reported as a control we
// could not drive, and the step was stored — and shown to the customer, and
// handed to the next walk through the journey's plan — as
// `Expand "Add login &amp; notes (optional)"`.
//
// So the escaping is undone where the model's words come in, before a tool
// acts on them and before anything is stored. Exactly one level of it, and
// only when the text shows the model was escaping:
//
//   - only "&amp;" → "&". No other entity is touched. A finding may QUOTE
//     entity text a page really shows ("&gt;&gt; And they weren&#39;t…" on a
//     page that fails to render them — meetbashar.com #216); under the model's
//     escaping that quote arrives as "&amp;gt;&amp;gt; … weren&amp;#39;t", and
//     one level off is the page's own text. Decoding everything would erase
//     the evidence the finding rests on.
//   - only in a text with no bare "&". A model that was not escaping wrote its
//     ampersands bare; an "&amp;" beside one is something it was quoting, and
//     stays. (Production, 2026-10-02: 24 step texts hold "&amp;", none of them
//     beside a bare "&", and none holds any other entity of the model's own.)
//
// Known limit: a text whose ONLY ampersand is a page's literal "&amp;", quoted
// by a model that was not escaping, reads the same as an escaped "&" and is
// decoded. It cannot be told apart from the words alone.

// An "&" that begins an entity: named, decimal or hex.
const ENTITY = /&(?:[a-z][a-z0-9]{1,31}|#\d{1,7}|#x[0-9a-f]{1,6});/gi;

/** One level of the model's own "&amp;" off a single text. */
export function ownWords(text: string): string {
  if (!text.includes("&amp;")) return text;
  // Any "&" left once every entity is taken out is a bare one.
  if (text.replace(ENTITY, "").includes("&")) return text;
  return text.replace(/&amp;/g, "&");
}

/** The same, for every string inside a value a model produced (a tool call's input, parsed JSON). */
export function ownWordsDeep<T>(value: T): T {
  if (typeof value === "string") return ownWords(value) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => ownWordsDeep(item)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = ownWordsDeep(item);
    return out as T;
  }
  return value;
}

/**
 * A text block a model answered with. When it is JSON (a structured answer),
 * each string inside is judged on its own — one field's bare "&" says nothing
 * about another's. Otherwise line by line, for the same reason.
 */
export function ownWordsInAnswer(text: string): string {
  if (!text.includes("&amp;")) return text;
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.stringify(ownWordsDeep(JSON.parse(trimmed)));
    } catch {
      /* not JSON after all — prose that happens to start with a brace */
    }
  }
  return text.split("\n").map(ownWords).join("\n");
}
