import type { AppAnatomy } from "@/lib/types";
import type { ProposedJourney, ProposedMetric } from "./discovery";
import type { ExtensionSession } from "./extension-contract";

interface ProductRead {
  surface?: string;
  source?: string;
  balance?: number;
  startAvailable?: boolean;
  controls?: Array<{ role: string; name: string; editable?: boolean; protected?: boolean }>;
}

// The journeys below are written by us, so the model's own proposals - and the
// price and conversion it attached to them - are discarded with the rest. A
// journey that reaches the walk with no numbers is left unpriced, and an
// unpriced journey is filed as our gap on every run (the "[Checker gap] Checker
// cannot say what a journey costs its user" ticket). The numbers are what the
// script has the person do, counted by the journey-metrics guide, and they are
// only an opening value: a stored price is never restated by them.
function priced(price: number, conversion: number, note: string): ProposedMetric {
  return { price, conversion, note, seedOnly: true };
}

// Native discovery saw authentication but called Show Insights a harmless
// toggle and invented backend/storage services. The installed adapter knows
// this control starts capture. That primary journey must survive extraction.
export function shapeExtensionDiscovery(identity: ExtensionSession, observations: string, proposed: ProposedJourney[]): { journeys: ProposedJourney[]; anatomy: AppAnatomy } {
  const reads: ProductRead[] = observations.split("\n").filter(Boolean).map(line => JSON.parse(line));
  const controls = reads.flatMap(read => read.controls ?? []);
  const names = new Set(controls.map(control => control.name));
  const account = reads.some(read => read.source === "account-ui" && Number.isSafeInteger(read.balance));
  const practice = reads.some(read => read.surface === "practice-page" && read.startAvailable);
  const journeys = [...proposed];
  const anatomy: AppAnatomy = {
    pages: [...new Set(reads.flatMap(read => read.surface === "native-popup" ? ["Extension popup"] : read.surface === "extension-panel" ? ["Interview assistance panel"] : read.surface === "practice-page" ? ["AI practice"] : read.source === "account-ui" ? ["Account"] : []))],
    actions: [...new Set(controls.filter(control => /button|link|combo box|check box/.test(control.role) && !control.protected)
      .map(control => control.name).filter(name => name && !name.includes("{{") && !name.includes("[existing document]")))],
    services: [],
    tech: { Version: identity.installedVersion },
  };
  if (identity.extensionId === "hafhjepjihcimcljkdphpinannbdmnhf") {
    journeys.length = 0;
    if (names.has("Show JobLander Insights")) journeys.push({
      title: "Interview assistance and session minutes",
      extensionScenario: "interview",
      metric: priced(10, 70, "Open the extension and sign in (5), open the interview page, show the insights and start (3), then stop and confirm (2); it leaves the extension for another page and spends paid minutes."),
      steps: [
        "Sign in to the extension with the existing test account.",
        "Read the account's minute balance and session history before starting.",
        "Start JobLander Insights on the interview page.",
        "Receive a new answer relevant to the interview question.",
        "Observe the session through its allotted duration and end it with confirmation.",
        "Check the new session's duration, minute debit and when the balance settles after Stop.",
      ],
    });
    if (practice) journeys.push({ title: "AI practice and session minutes", extensionScenario: "practice", metric: priced(7, 65, "Choose the coach and the language (2), check the microphone and allow it (2), start the call (1), end it and confirm (2); the browser's microphone prompt is the hard moment."), steps: [
      "Read the test account's minute balance and session history.",
      "Prepare the practice page with Aria and English, then check the microphone.",
      "Start practice with the microphone on and receive a relevant coach response to the candidate's answer.",
      "Observe practice through its allotted duration, end it and see Start call again.",
      "Check its duration, minute debit and when the balance settles after Stop.",
    ] });
    if (practice && names.has("Show JobLander Insights")) journeys.push({ title: "Practice with interview assistance", extensionScenario: "practice-extension", metric: priced(11, 55, "Choose the coach and the language (2), check and allow the microphone (2), open the popup and start insights (2), start the call (1), then end both sessions (4); two paid sessions run side by side."), steps: [
      "Sign in to the extension and read the same test account's minute balance and history.",
      "Prepare the practice page with Aria and English and check its microphone before either session.",
      "Open the extension popup on the practice page and start interview assistance first.",
      "Start practice with the microphone on and receive a relevant coach response and a new extension answer.",
      "Observe both sessions through their allotted durations and end both.",
      "Check each duration separately, the sum of the two rounded minute debits and when the balance settles after both sessions end.",
    ] });
    if (names.has("Sign in with email")) journeys.push({ title: "Email sign-in", metric: priced(5, 85, "Open the extension, choose Sign in with email, type the address and the password, and submit."), steps: [
      "Open the extension and choose Sign in with email.",
      "Sign in with the existing test account.",
      "See the account and interview-assistance controls.",
    ] });
    if (account) journeys.push({ title: "Account minutes and session history", metric: priced(6, 85, "Open the extension and sign in with email (5), then open the account to read the minutes and past sessions (1)."), steps: [
      "Sign in with the existing test account.",
      "Read the available minutes and previous sessions.",
    ] });
    if (names.has("Show JobLander Insights")) anatomy.actions.push("Start interview assistance");
  }
  return { journeys: journeys.slice(0, 5), anatomy };
}
