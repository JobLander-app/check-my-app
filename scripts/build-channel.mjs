// Builds the checkmyapp-watch channel into an npm-installable tarball served
// from our own site (CHE-319):
//
//   npm run build:channel   →   public/mcp/checkmyapp-watch-<version>.tgz
//
// which a customer runs with
//
//   npx -y https://checkmyapp.dev/mcp/checkmyapp-watch-<version>.tgz
//
// Not the npm registry: there is no publish token, and a tarball next to the
// site ships with the deploy that changed it. The package has zero
// dependencies — esbuild bundles the MCP SDK into the one bin file — so `npx`
// installs nothing but the tarball itself, and the node floor is the SDK's
// (18).
//
// A published version is immutable. npx keeps the first install of a URL and
// fetches the URL on every start (mcp/channel/watch.ts, CHANNEL_VERSION): new
// bytes under an old name reach nobody who has it, and a removed file breaks
// them. So this refuses to overwrite a version with different contents — bump
// CHANNEL_VERSION — and never deletes an older one.
//
// The tarball is committed. scripts/verify-mcp-channel.ts rebuilds it with
// buildChannel() and fails when the committed one holds anything else, so
// changing mcp/channel/ without running this cannot reach a deploy.

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BIN = "checkmyapp-watch.js";

export function channelVersion() {
  const src = readFileSync(path.join(repoRoot, "mcp", "channel", "watch.ts"), "utf8");
  const m = /CHANNEL_VERSION = "([^"]+)"/.exec(src);
  if (!m) throw new Error("CHANNEL_VERSION not found in mcp/channel/watch.ts");
  return m[1];
}

export function tarballPath(version = channelVersion()) {
  return path.join(repoRoot, "public", "mcp", `checkmyapp-watch-${version}.tgz`);
}

// The package's files, as { relative path → contents }. Everything the
// tarball holds comes from here, so the verify script compares exactly this.
export async function buildChannel() {
  const result = await build({
    entryPoints: [path.join(repoRoot, "mcp", "channel", "bin.ts")],
    bundle: true,
    platform: "node",
    target: "node18",
    format: "cjs",
    write: false,
    minify: false,
    legalComments: "inline",
    banner: { js: "#!/usr/bin/env node" },
    logLevel: "warning",
    // Paths in the bundle's comments are relative to this, so the output does
    // not depend on which checkout built it…
    absWorkingDir: repoRoot,
    // …including a worktree whose node_modules is a symlink to the main
    // checkout's (the way every worktree here is set up): without this esbuild
    // follows the link and writes "../../../node_modules/…" into the comments,
    // and the tarball differs from CI's by path alone (Codex on #278).
    preserveSymlinks: true,
  });
  const pkg = {
    name: "checkmyapp-watch",
    version: channelVersion(),
    description:
      "CheckMyApp Daily Watch results pushed into a running Claude Code session (a Claude Code channel). https://checkmyapp.dev",
    homepage: "https://checkmyapp.dev/guides/results-in-your-agent",
    license: "UNLICENSED",
    bin: { "checkmyapp-watch": BIN },
    files: [BIN],
    engines: { node: ">=18" },
  };
  return {
    "package.json": JSON.stringify(pkg, null, 2) + "\n",
    [BIN]: result.outputFiles[0].text,
  };
}

async function packChannel() {
  const dest = tarballPath();
  const files = await buildChannel();
  const stage = mkdtempSync(path.join(tmpdir(), "checkmyapp-watch-"));
  try {
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(path.join(stage, name), text, { mode: name === BIN ? 0o755 : 0o644 });
    }
    const out = execFileSync("npm", ["pack", "--json", "--pack-destination", stage], { cwd: stage, encoding: "utf8" });
    const built = path.join(stage, JSON.parse(out)[0].filename);
    if (existsSync(dest)) {
      // npm pack is byte-stable for the same files (fixed mtimes), so equal
      // bytes mean equal contents.
      if (readFileSync(dest).equals(readFileSync(built))) return { dest, changed: false };
      throw new Error(
        `${path.relative(repoRoot, dest)} is already published with different contents. ` +
          "Bump CHANNEL_VERSION in mcp/channel/watch.ts — people who installed this version keep it forever.",
      );
    }
    mkdirSync(path.dirname(dest), { recursive: true });
    renameSync(built, dest);
    return { dest, changed: true };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // No top-level await: verify-mcp-channel.ts imports this through tsx, which
  // compiles it as CommonJS.
  packChannel().then(
    ({ dest, changed }) =>
      console.log(
        `${changed ? "built" : "unchanged"} ${path.relative(repoRoot, dest)} (${readFileSync(dest).length} bytes)`,
      ),
    (err) => {
      console.error(`build:channel: ${err.message}`);
      process.exit(1);
    },
  );
}
