// File upload and download handling for the walk (CHE-146).
//
// Upload-centric products (documents, images, CVs) have their core action
// unverified — the walk could click "Upload" or focus an <input type="file">,
// but had no way to provide the file itself. Playwright surfaces both halves
// of that, and this file is the only place the tools use them:
//
//   - <input type="file">: fill sets the files with locator.setInputFiles —
//     what a real browser does when the OS picker is gone.
//
//   - a click that opens the OS picker: page.on("filechooser") catches it,
//     and the next click / navigate / fill that runs during the chooser set
//     the file the walk chose. The chooser is set ONCE per pick; the second
//     pick needs a fresh listener, attached the first time a run sees the
//     picker (attachFileChooserCapture).
//
//   - a download the page offers: page.on("download") catches it, the URL and
//     the suggested filename are added to a rolling log like network/console,
//     and the digest reports them so the walk can say "downloaded …" with
//     what it actually was, instead of filing the link as unverifiable.
//
// The fixture file lives at scripts/fixtures/upload-sample.txt and is the
// file every fixture in the verify script uploads. It is created if absent so
// the script is self-contained on a fresh checkout (CHE-183).

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page, Download, Locator } from "@cloudflare/playwright";

// What `input` an element claims to be when asked in the page. The two ways a
// file field is named in markup are <input type="file"> and (rarely) a button
// that calls click() on one — both surface as type "file" to the DOM, so this
// is what the tools check.
export async function isFileInput(locator: Locator): Promise<boolean> {
  try {
    return (await locator.evaluate((el) => (el as HTMLInputElement).type === "file")) === true;
  } catch {
    return false;
  }
}

// The fixture the walk uploads. One file, small, with a known name so the
// digest can name it too. Self-creating so the script needs no setup; the
// file is gitignored in spirit (small, deterministic, never real data).
export const UPLOAD_FIXTURE_NAME = "upload-sample.txt";
export const UPLOAD_FIXTURE_BODY =
  "CheckMyApp upload fixture — a small text file the walk attaches to file inputs.\n";

export function uploadFixturePath(): string {
  const dir = path.resolve(process.cwd(), "scripts/fixtures");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = path.join(dir, UPLOAD_FIXTURE_NAME);
  if (!existsSync(file)) writeFileSync(file, UPLOAD_FIXTURE_BODY, "utf8");
  return file;
}

// One file path the walk can hand to setInputFiles. The model never types the
// path; the tools resolve it from a placeholder ({{TEST_FILE}}) so the path
// never appears in the prompt, the transcript or the trail. Anything outside
// this list is refused — a path the model invented is not a fixture we own.
export const TEST_FILE_PLACEHOLDER = "{{TEST_FILE}}";

export function resolveUploadPath(raw: string): string | null {
  if (raw !== TEST_FILE_PLACEHOLDER) return null;
  return uploadFixturePath();
}

// The "file chooser in flight" — set by attachFileChooserCapture when Playwright
// fires it, consumed by the next click / fill on the page. Cleared by either
// the consumer (a successful setFiles) or by a settleFiles call without one
// firing (the chooser was a native dialog the page dismissed on its own).
export interface PendingFileChooser {
  setFiles: (files: string | string[]) => Promise<void>;
}

// Bound once per page; the chooser is the one Playwright just handed us. A
// second chooser before the first is consumed overrides it — what a picker
// that re-fires immediately on a stale form would look like, and what a
// page that does file = input.click(); input.change() in one tick looks like.
export function attachFileChooserCapture(page: Page, state: { pending?: PendingFileChooser }): void {
  page.on("filechooser", async (chooser) => {
    state.pending = {
      setFiles: (files: string | string[]) => chooser.setFiles(files),
    };
  });
}

// Drain whatever the chooser caught. Called from click() before the inert
// fallback, so a press that opens a picker is met with the file the walk
// chose, not "the page did nothing". Returns the path actually set (one
// fixture is enough for the verify script; the model picks nothing here, the
// placeholder does), or null if there was no chooser.
export async function settleChooserIfAny(state: { pending?: PendingFileChooser }, filePath: string): Promise<string | null> {
  const chooser = state.pending;
  if (!chooser) return null;
  state.pending = undefined;
  try {
    await chooser.setFiles(filePath);
    return filePath;
  } catch {
    return null;
  }
}

// Downloads — page.on("download") catches the file the browser saved to disk.
// The walk reads its URL and suggested filename from the event; the body is
// kept by the browser, not by us (Workers have no filesystem and the file
// rarely matters for what the walk is checking). A rolling log like the
// network/console one keeps the last few so the digest can report them
// without page state.
export interface CapturedDownload {
  url: string;
  suggestedFilename: string;
}

export function attachDownloadCapture(page: Page, log: CapturedDownload[]): void {
  page.on("download", (download: Download) => {
    log.push({ url: download.url(), suggestedFilename: download.suggestedFilename() });
    if (log.length > 50) log.splice(0, 25);
  });
}
