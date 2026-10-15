// CHE-464: how the Worker addresses a session browser — its Durable Object
// (session-runner.ts). Apart from the class so that session-browser.ts, which
// the guards run in Node, never imports the container runtime.
//
// CHE-482: the object is named by its slot — one person's in one team
// (sessionSlot, src/lib/session-view.ts) — not by the team.

import type { AgentBindings } from "./env";
import { SESSION_SLOT } from "@/lib/session-view";

// Which slot a request to a session browser is for. The object refuses any
// other slot than the one it was first asked for.
export const SESSION_SLOT_HEADER = "X-Session-Slot";

export function sessionRunnerFor(bindings: Pick<AgentBindings, "SESSION_RUNNER">, slot: string) {
  if (!bindings.SESSION_RUNNER) throw new Error("internal: the session browser binding is unavailable");
  if (!SESSION_SLOT.test(slot)) throw new Error("internal: a session browser needs its slot");
  return bindings.SESSION_RUNNER.getByName(slot);
}
