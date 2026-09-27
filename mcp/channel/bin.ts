// Entry point of the checkmyapp-watch bundle (CHE-319). Kept apart from
// server.ts so importing the server — as scripts/verify-mcp-channel.ts does —
// starts nothing.

import { main } from "./server";

main().catch((err) => {
  process.stderr.write(`[checkmyapp-watch] ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
