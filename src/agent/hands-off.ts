// What a walk does not press.
//
// The word lists are the ones the click tool has always tested the NAME of a
// control against (CHE-89, CHE-98, CHE-193). CHE-406 adds the second reading:
// the control itself.
//
// Run #304 (checkmyapp.dev, 2026-10-02): five journeys stopped at the
// onboarding button "Save & start watching" — "start watching" is a state
// toggle, refused in every mode — and a sixth pressed it. Its click was
// `{"selector":"button[type=submit]"}`: the gate read the name the walk gave
// the control, the walk gave none, and an app with a daily watch was created
// in our own product, then edited. A gate that reads only what the model calls
// a control is a request to the model.
//
// So, in the two places where what stands behind the control is not ours to
// change at all, the control is judged by what it IS — its own text, its
// accessible name, its value, its label — however it was addressed, and the
// create gate's "press it by selector if it only reads" path does not exist:
//   - inside a person's signed-in session (CHE-389): their real account, their
//     real store, reached past a sign-in they made by hand;
//   - on our own product, where a press acts on real users' data and money.
// There too, a run that may not write is refused the controls that remove or
// commit something — no list tested those before, and the instruction not to
// press them was the only thing in the way.
//
// Deliberately not judged this way:
//   - a link that leads somewhere, and a tab: opening "Add product" or the
//     "Block countries" page is reading. What would act is the button there;
//   - a field: its placeholder ("Add a note…") is not a press;
//   - text longer than a label: a card or a row the walk pressed to open it is
//     not named by every word inside it.
//
// Known limit, said so it is not mistaken for coverage: a control whose words
// say nothing of what it does — an icon with no name, "OK", "Yes", "Continue"
// on a confirmation — is not seen here. Everywhere else (an ordinary run on a
// customer's app) the gates still read only the name; that half needs numbers
// on what it would refuse before it is switched on.

import type { ControlSeen } from "./session-browser";

// Buttons that leave state behind. Deterministic refusal beats instruction:
// run #108 created a real app during discovery, where the prompt had already
// said read-only — and never ledgered it, so cleanup could not see it either.
export const CREATE_VERBS =
  /\b(create|register|sign ?up|save|add|publish|post|submit|send|order|buy|subscribe|book|invite|start watching|place order)\b/i;
// Submits that only read: never blocked.
export const SAFE_SUBMITS = /\b(search|filter|apply filter|log ?in|sign ?in|continue|next|show|find|preview|refresh)\b/i;

// Controls that flip the state of something that ALREADY exists — someone
// else's record, not ours. Refused in every mode, including runs allowed to
// create: permission to add a test record was never permission to resume a
// paused subscription, cancel a plan or re-enable a watch. Our own self-check
// re-enabled a watch its owner had paused (CHE-98) and quietly spent $1.26
// re-checking a domain nobody wanted checked.
export const STATE_TOGGLE_VERBS =
  /\b(enable|disable|resume|reactivate|activate|deactivate|pause|unpause|cancel|upgrade|downgrade|subscribe|unsubscribe|renew|restore|archive|revoke|start watching|turn (on|off))\b/i;

// CHE-193: controls on OUR OWN product that act on real users' data. The
// self-check of 2026-09-05 (run #146) pressed "Re-check now" on a stranger's
// public verdict page and created two real runs (#147, #148), then pressed
// "Looks right ✓" and graded a stranger's verdict. None of these labels is a
// create or a toggle in the CREATE_VERBS / STATE_TOGGLE_VERBS sense, so a new
// list, applied only when the target is one of our hosts (self-hosts.ts) — on
// a customer's app "Export" or "Check now" is theirs to have pressed. The web
// half answers 403 to the same actions when the self-check header is present;
// this gate keeps the walk from even asking. The list is the ticket's: the $1
// check, a re-check, the verdict lens ("Looks right", "Something's off",
// "That's fine", "Mark as fixed", "Dispute"), tickets and exports. "Enable
// Daily Watch" is caught by STATE_TOGGLE_VERBS, in every mode.
export const SELF_HOST_GUARDED_VERBS =
  /\b(re-?check|check now|run check|run (this one|it|one) now|run now|looks right|something'?s off|that'?s fine|mark as|dispute|file ticket|create ticket|export)\b/i;

// CHE-406: what takes something away, and what commits a change, said the
// ways a product's own buttons say it. Tested only against the control itself,
// only in a strict place, only in a run that may not write.
export const REMOVE_VERBS =
  /\b(delete|remove|uninstall|unpublish|erase|destroy|purge|wipe|reset|clear all|block|unblock|ban|unban|disconnect|unlink|revert|roll ?back)\b/i;
export const COMMIT_VERBS =
  /\b(update|apply|confirm|approve|install|import|generate|regenerate|duplicate|pay|charge|refund|fulfil+|transfer|grant|rotate|connect|mark (?:as|all)|unpin|pin (?:this |the )?app|accept (?:the )?(?:invit\w+|terms|charge|offer)|start (?:(?:your|a|my|free) )*trial|(?:select|choose|change|switch) (?:this )?plan)\b/i;

// Where the run stands and what it may do.
export interface HandsOffPlace {
  // Inside a person's signed-in session (session-browser.ts inSignedInSession).
  session: boolean;
  // The target is one of our own hosts (self-hosts.ts isSelfUrl).
  ownHost: boolean;
  // The owner allowed this run to create records (App.writeMode + a test account).
  writeAllowed: boolean;
}

export type HandsOffRule = "own_host" | "toggle" | "create" | "remove" | "commit" | "switch";

export interface HandsOff {
  rule: HandsOffRule;
  // The control's own words, as the page has them.
  what: string;
}

// The places where a control is judged by what it is.
export function isStrictPlace(place: Pick<HandsOffPlace, "session" | "ownHost">): boolean {
  return place.session || place.ownHost;
}

// A label is short. Whatever is longer is a container's text.
const LABEL_LIMIT = 120;

const TYPED_INTO = /^(textarea|select|input:(?!submit$|button$|image$|reset$|checkbox$|radio$|file$).+)$/;

// A link that leads to an address — not "#", not a script, not nothing.
function leadsSomewhere(control: ControlSeen): boolean {
  if (control.kind !== "a" && control.kind !== "link") return false;
  const href = (control.link ?? "").trim();
  return href !== "" && !href.startsWith("#") && !/^javascript:/i.test(href);
}

function named(texts: string[], verbs: RegExp): string | null {
  const hit = texts.find((t) => verbs.test(t) && !SAFE_SUBMITS.test(t));
  return hit ? hit.replace(/\s+/g, " ").trim().slice(0, 80) : null;
}

// → the rule this control falls under in this place, or null. Null in an
// ordinary run on a customer's app, whatever the control: there the name the
// walk gave is all that is tested (tools.ts click), as before.
export function handsOffIn(control: ControlSeen, place: HandsOffPlace): HandsOff | null {
  if (!isStrictPlace(place)) return null;
  const kind = control.kind ?? "";
  if (TYPED_INTO.test(kind) || kind === "tab" || leadsSomewhere(control)) return null;
  const texts = control.texts.filter((t) => t.length <= LABEL_LIMIT);

  if (place.ownHost) {
    const what = named(texts, SELF_HOST_GUARDED_VERBS);
    if (what) return { rule: "own_host", what };
  }
  const toggled = named(texts, STATE_TOGGLE_VERBS);
  if (toggled) return { rule: "toggle", what: toggled };
  if (place.writeAllowed) return null;

  const created = named(texts, CREATE_VERBS);
  if (created) return { rule: "create", what: created };
  const removed = named(texts, REMOVE_VERBS);
  if (removed) return { rule: "remove", what: removed };
  const committed = named(texts, COMMIT_VERBS);
  if (committed) return { rule: "commit", what: committed };
  // An on/off setting takes effect when it is pressed, and says so nowhere.
  if (place.session && kind === "switch") return { rule: "switch", what: texts[0]?.replace(/\s+/g, " ").trim().slice(0, 80) || "the switch" };
  return null;
}

const THEN =
  `Confirm the control is present and reachable, report the step "skipped" with unverifiedReason ` +
  `"not_applicable", and move on. Do not press it by another name, another selector or another route.`;

// What the walk is told. It names the product's control and nothing of ours.
export function handsOffRefusal(held: HandsOff): string {
  switch (held.rule) {
    case "own_host":
      return (
        `Refused: "${held.what}" acts on real data of this product's users — a check that costs ` +
        `money, a verdict that belongs to someone else, a ticket on someone's board. That is ` +
        `never ours to press. ${THEN}`
      );
    case "toggle":
      return (
        `Refused: "${held.what}" would change the state of something that already exists in this ` +
        `product — a subscription, a schedule, a setting someone deliberately set. That is never ` +
        `ours to touch, whatever this run is allowed to create. ${THEN}`
      );
    case "create":
      return (
        `Refused: "${held.what}" would create, save or send something in this product, and this ` +
        `run only reads. You have confirmed the form accepts input — that is the whole check here. ${THEN}`
      );
    case "remove":
      return (
        `Refused: "${held.what}" would remove or undo something that exists in this product, and ` +
        `this run only reads. ${THEN}`
      );
    case "commit":
      return (
        `Refused: "${held.what}" would commit a change in this product — to its data, its plan or ` +
        `its settings — and this run only reads. ${THEN}`
      );
    case "switch":
      return (
        `Refused: "${held.what}" is an on/off setting of this product, and pressing it changes the ` +
        `setting. This run only reads. ${THEN}`
      );
  }
}
