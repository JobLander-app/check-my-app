// CHE-464: how the Worker addresses a team's session browser — its Durable
// Object, named by the team's id (session-runner.ts). Apart from the class so
// that session-browser.ts, which the guards run in Node, never imports the
// container runtime.

import type { AgentBindings } from "./env";

// Which team a request to a session browser is for. The object refuses any
// other team than the one it was first asked for.
export const SESSION_TEAM_HEADER = "X-Session-Team";
export const SESSION_TEAM_ID = /^[A-Za-z0-9_-]{1,100}$/;

export function sessionRunnerFor(bindings: Pick<AgentBindings, "SESSION_RUNNER">, teamId: string) {
  if (!bindings.SESSION_RUNNER) throw new Error("internal: the session browser binding is unavailable");
  if (!SESSION_TEAM_ID.test(teamId)) throw new Error("internal: a session browser needs the team's id");
  return bindings.SESSION_RUNNER.getByName(teamId);
}
