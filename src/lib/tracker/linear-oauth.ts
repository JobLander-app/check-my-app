// Linear OAuth2 handshake (CHE-31). Multi-tenant: each team authorizes its
// own workspace; we store the resulting access token (encrypted) per team
// (CHE-469, src/lib/tracker/connection.ts).
// Spec: authorize https://linear.app/oauth/authorize, token exchange
// POST https://api.linear.app/oauth/token (form-urlencoded). Actor=Application
// is set in the Linear app settings so tickets are created by the integration.

import { linearAuthHeader } from "./linear-auth";

const AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const TOKEN_URL = "https://api.linear.app/oauth/token";
const GRAPHQL_URL = "https://api.linear.app/graphql";

// read = list teams/labels/states; write + issues:create + comments:create = file/update tickets.
const SCOPES = "read,write,issues:create,comments:create";

export function buildAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    scope: SCOPES,
    state: opts.state,
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export interface LinearToken {
  access_token: string;
  // Rotating refresh token (CHE-68) — present when the OAuth app has token
  // expiry enabled, which Linear now does for 24h access tokens.
  refresh_token?: string;
  expires_in?: number;
  scope: string;
  token_type: string;
}

export async function exchangeCode(opts: {
  code: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}): Promise<LinearToken> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Linear token exchange failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as LinearToken;
}

// All teams in the authorized workspace, for the team picker; the first is
// the default ticket destination at connect time (linear-connect.ts). Linear
// caps the page at 250; an owner with more teams is far outside our ICP.
export async function fetchTeams(
  accessToken: string,
): Promise<{ id: string; name: string }[]> {
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: linearAuthHeader(accessToken),
    },
    body: JSON.stringify({ query: "{ teams(first: 250) { nodes { id name } } }" }),
  });
  const json = (await res.json()) as {
    data?: { teams: { nodes: { id: string; name: string }[] } };
  };
  return json.data?.teams.nodes ?? [];
}
