// Where the two ways out of an empty balance live (CHE-327). Every refusal —
// the dashboard, the API, MCP, the paused-watch mail — carries both, so a
// limit is never met without its door.
//
// Both are pages, not endpoints: a checkout needs a signed-in admin's session
// and a POST, so it is not a link anyone can be handed. /pricing's buttons
// start the plan checkout; the balance card on Billing starts a top-up.

// Upgrade: the plan cards.
export const PRICING_PATH = "/pricing";
// Top up: the balance card on Billing, where the buttons are (CHE-351; it was
// /dashboard#balance, which now arrives here too).
export const BALANCE_PATH = "/settings/billing";
