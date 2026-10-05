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
// A link that leads to an address is judged as a link (Codex on #261):
//   - where it leads decides. An address that names an action — /delete,
//     /orders/7/cancel, ?action=trash — is not opened, by a click or by
//     navigate: "a GET that changes state is a GET a scanner will press"
//     (AGENTS.md), and so would a walk;
//   - a link whose words say it changes something ("Cancel subscription",
//     "Delete", and equally "Block countries", which only opens a page) is not
//     CLICKED — a click runs whatever script the page hung on it — and the
//     walk is told to open its address instead, where the rule above applies
//     and no script of the link's runs;
//   - a link that opens a form ("Add product") is followed: that is reading.
//
// Deliberately not judged at all:
//   - a tab: switching the view is reading;
//   - a field: its placeholder ("Add a note…") is not a press;
//   - text longer than a label: a card or a row the walk pressed to open it is
//     not named by every word inside it.
//
// The price, inside a person's account: a checkbox or a radio button is never
// pressed there, so one that only selects a row or narrows a list is not
// pressed either, and a button with no name stays shut. Those are steps we
// could not take — ours to say so — not defects of the product.
//
// Known limit, said so it is not mistaken for coverage: a control whose words
// say nothing of what it does — "OK", "Yes" on a confirmation — is not seen
// here, and neither is an address that changes state without saying so.
// Everywhere else (an ordinary run on a customer's app) the gates still read
// only the name; that half needs numbers on what it would refuse before it is
// switched on.

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

export type HandsOffRule = "own_host" | "toggle" | "create" | "remove" | "commit" | "switch" | "unnamed" | "address" | "link" | "unreadable";

// A control that could not be read at all (Codex on #261, round 3): the page
// re-rendered under the question, or the element went away. In a strict place
// what cannot be read is not pressed — the click that follows would find the
// control again and press whatever it turned out to be.
export function handsOffUnread(place: HandsOffPlace): HandsOff | null {
  return isStrictPlace(place) ? { rule: "unreadable", what: "the control" } : null;
}

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

// What makes a label safe is the whole of what it does, not a word in it:
// "Apply filter" filters, "Save and continue" saves (Codex on #261). So the
// words that only read are taken out, and the verbs are looked for in what is
// left.
const READS_ONLY =
  /\b(?:(?:add|apply|reset|clear(?: all)?|remove) (?:all |the |a )?(?:filters?|search|sorting)|search|filters?|log ?in|sign ?in|continue|next|show|find|preview|refresh)\b/gi;

// A question asks, it does not do: "How do I get a refund?" is an FAQ
// accordion, not a refund (the one false hold in CHE-407's replay of 483
// customer clicks). A question is one by its words, not by its punctuation
// (Codex on #277): "Delete account?" is a button that deletes, and stays
// held. A control is still judged by its other names.
const ASKS =
  /^(?:how|what|why|when|where|which|who|whom|whose|can|could|do|does|did|is|are|was|were|should|shall|will|would|may|might|need|want|forgot|looking|having|wondering|not sure)\b[^?]*\?\s*$/i;

function named(texts: string[], verbs: RegExp): string | null {
  const hit = texts.find((t) => !ASKS.test(t) && verbs.test(t.replace(READS_ONLY, " ")));
  return hit ? hit.replace(/\s+/g, " ").trim().slice(0, 80) : null;
}

// An address that names an action: a path segment, or a query key or value,
// that IS one of the verbs the gates hold — "/orders/7/cancel", "/delete/42",
// "/users/42/block", "?action=trash". Every single-word verb of the toggle,
// remove and commit lists is here (Codex on #261, round 3: a link refused for
// its word is sent to its address, so the address must be refused for the same
// word; verify:hands-off reads the lists and fails on one that is missing).
// A segment that only begins with a verb names a page — "/block-countries",
// "/cancellation-policy", "/removed-items" — and is read like any other.
const ACTION_WORDS =
  "delete|destroy|remove|trash|erase|purge|wipe|reset|block|unblock|ban|unban|disconnect|unlink|revert|rollback|roll-back|uninstall|unpublish|" +
  "enable|disable|resume|reactivate|activate|deactivate|pause|unpause|cancel|upgrade|downgrade|subscribe|unsubscribe|renew|restore|archive|revoke|" +
  "update|apply|confirm|approve|install|import|generate|regenerate|duplicate|pay|charge|refund|fulfill|fulfil|transfer|grant|rotate|connect|unpin";
const ACTION_ADDRESS = new RegExp(`(^|[/=?&])(${ACTION_WORDS})([/?&#=]|$)`, "i");

export function isActionAddress(url: string | null | undefined, base?: string): boolean {
  if (!url) return false;
  let address = url;
  try {
    const parsed = new URL(url, base);
    address = `${parsed.pathname}${parsed.search}`;
  } catch {
    /* not an address we can resolve — judged as written */
  }
  return ACTION_ADDRESS.test(address);
}

const PRESSED = /^(button|menuitem|input:(submit|button|image))$/;
const ON_OFF = /^(switch|checkbox|radio|menuitemcheckbox|menuitemradio|input:(checkbox|radio))$/;

// → the rule this control falls under in this place, or null. Null in an
// ordinary run on a customer's app, whatever the control: there the name the
// walk gave is all that is tested (tools.ts click), as before.
export function handsOffIn(control: ControlSeen, place: HandsOffPlace): HandsOff | null {
  if (!isStrictPlace(place)) return null;
  const kind = control.kind ?? "";
  if (TYPED_INTO.test(kind) || kind === "tab") return null;
  const texts = control.texts.filter((t) => t.length <= LABEL_LIMIT);
  const link = leadsSomewhere(control);

  // Where it leads, or where its form is sent.
  const acts = [control.link ?? "", ...control.addresses].find((a) => isActionAddress(a, control.base));
  if (acts) return { rule: "address", what: acts.slice(0, 120) };

  const held = (rule: HandsOffRule, verbs: RegExp): HandsOff | null => {
    const what = named(texts, verbs);
    return what ? { rule: link ? "link" : rule, what } : null;
  };
  const always = (place.ownHost ? held("own_host", SELF_HOST_GUARDED_VERBS) : null) ?? held("toggle", STATE_TOGGLE_VERBS);
  if (always) return always;
  // In a person's account, whatever the run may create (Codex on #261, round
  // 2): permission to add a test record was never permission to flip a
  // setting that was already there.
  if (place.session && !link) {
    // A switch, a checkbox, a radio button: an on/off setting takes effect
    // when it is pressed — many pages save it on the spot — and its name
    // ("Email alerts") says nothing of that.
    if (ON_OFF.test(kind)) return { rule: "switch", what: texts[0]?.replace(/\s+/g, " ").trim().slice(0, 80) || "the setting" };
    // A button with no name at all — no text, no accessible name, no title —
    // cannot be told from "Delete". It is not pressed.
    if (PRESSED.test(kind) && control.texts.length === 0) return { rule: "unnamed", what: "a button with no name" };
  }
  if (place.writeAllowed) return null;

  // A link that opens a form is reading; a button that says "Add" adds.
  const created = link ? null : held("create", CREATE_VERBS);
  return created ?? held("remove", REMOVE_VERBS) ?? held("commit", COMMIT_VERBS);
}

// The same judgement for an address the walk types (tools.ts navigate).
export function handsOffAddress(url: string, place: HandsOffPlace): HandsOff | null {
  if (!isStrictPlace(place) || !isActionAddress(url)) return null;
  let what = url;
  try {
    const parsed = new URL(url);
    what = `${parsed.pathname}${parsed.search}`;
  } catch {
    /* as written */
  }
  return { rule: "address", what: what.slice(0, 120) };
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
        `setting. That is never ours to touch. ${THEN}`
      );
    case "unnamed":
      return (
        `Refused: this is ${held.what} — no text, no accessible name, no title — so what it does ` +
        `cannot be read before it is pressed, and this run only reads. ${THEN}`
      );
    case "unreadable":
      return (
        `Refused: ${held.what} could not be read just now, so what it does is not known, and here a ` +
        `control is not pressed before it is read. Re-read the page and address the control again; ` +
        `if it still cannot be read, report the step "skipped" with unverifiedReason ` +
        `"our_capability" and move on.`
      );
    case "address":
      return (
        `Refused: the address "${held.what}" names an action, and opening it would carry that ` +
        `action out. This run only reads. Report the step "skipped" with unverifiedReason ` +
        `"not_applicable" and move on. Do not reach it by a click, by typing it or by another route.`
      );
    case "link":
      return (
        `Refused: "${held.what}" is a link whose words say it changes something, so it is not ` +
        `pressed. If it only opens a page, open that page by its address with navigate — what the ` +
        `page shows is yours to read. Otherwise report the step "skipped" with unverifiedReason ` +
        `"not_applicable" and move on.`
      );
  }
}
