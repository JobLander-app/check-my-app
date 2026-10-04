// The self-check guard for server actions (CHE-194).
//
// src/lib/self-check.ts is the contract and has no framework import, so a
// route handler, a test or the agent can use it. A server action reads its
// request through next/headers and refuses by redirecting — that half lives
// here, outside any "use server" file: everything such a file exports becomes
// an action a browser can call, and a guard must not be one.
//
// Used as the FIRST statement of an action — before auth, before the database,
// before the form is read:
//
//   await refuseSelfCheck(`/dashboard/${appId}`);
//
// The path is where the browser lands, with ?self_check=read_only appended.
// The page renders nothing for the flag on purpose (a self-check must not see
// anything a visitor would not); the agent's tools read the address
// (self-hosts.ts isSelfCheckRedirect) and report the step as stopped on
// purpose.

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isSelfCheckRequest, selfCheckRedirectPath } from "@/lib/self-check";

export async function refuseSelfCheck(path: string): Promise<void> {
  if (isSelfCheckRequest(await headers())) redirect(selfCheckRedirectPath(path));
}
