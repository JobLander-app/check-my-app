export interface ExtensionLink {
  id: string;
  storeUrl: string;
  label: string;
}

// Store slugs are editable; the 32-character ID is the stable product identity.
export function parseExtensionLink(raw: string): ExtensionLink | null {
  try {
    const url = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
    if (url.username || url.password || (url.port && url.port !== "443")) return null;
    const prefix = url.hostname === "chromewebstore.google.com" ? "/detail/"
      : url.hostname === "chrome.google.com" ? "/webstore/detail/" : null;
    if (!prefix || !url.pathname.startsWith(prefix)) return null;
    const parts = url.pathname.slice(prefix.length).replace(/\/$/, "").split("/");
    if (parts.length < 1 || parts.length > 2) return null;
    const id = parts.at(-1)!;
    if (!/^[a-p]{32}$/.test(id)) return null;
    const label = parts.length === 2 ? decodeURIComponent(parts[0]) : id;
    return { id, label, storeUrl: `https://chromewebstore.google.com/detail/${id}` };
  } catch { return null; }
}

export function isChromeStoreUrl(raw: string): boolean {
  try {
    const url = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
    return url.hostname === "chromewebstore.google.com" || url.hostname === "chrome.google.com" && url.pathname.startsWith("/webstore");
  } catch { return false; }
}

export function extensionDisplayName(targetUrl: string, evidence?: string | null): string {
  try {
    const name = (JSON.parse(evidence ?? "{}") as { identity?: { name?: unknown } }).identity?.name;
    if (typeof name === "string" && name.trim() && name.length <= 160 && !/[\u0000-\u001f]/.test(name)) return name.trim();
  } catch { /* The Store link remains usable before installation completes. */ }
  const link = parseExtensionLink(targetUrl);
  return link && link.label !== link.id ? link.label.replaceAll("-", " ") : "Chrome extension";
}

export interface ExtensionOptions {
  companionUrl?: string;
  expectedOutcome?: string;
  allowSessions?: boolean;
  maxSessionSeconds?: number;
}

export function extensionColumns(url: string, options?: ExtensionOptions) {
  const link = parseExtensionLink(url);
  return link ? { targetKind: "extension", extensionId: link.id, extensionConfig: JSON.stringify(options ?? {}) } : {};
}

export function readExtensionOptions(raw: string | null | undefined): ExtensionOptions {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const v = value as Record<string, unknown>;
    return {
      ...(typeof v.companionUrl === "string" ? { companionUrl: v.companionUrl } : {}),
      ...(typeof v.expectedOutcome === "string" ? { expectedOutcome: v.expectedOutcome.slice(0, 1000) } : {}),
      allowSessions: v.allowSessions === true,
      maxSessionSeconds: typeof v.maxSessionSeconds === "number" && Number.isInteger(v.maxSessionSeconds)
        ? Math.min(600, Math.max(60, v.maxSessionSeconds)) : 180,
    };
  } catch { return {}; }
}
// Whether a run's report may be read by anyone outside. CHE-329: a run that
// ended failed publishes nothing, whatever its kind (rule 4), and nothing
// written on its row before it died may be served as a result beside "this
// check didn't finish". (A step that throws AFTER the verdict was written
// leaves the run finished instead — workflow.ts "fail" — since the verdict
// may already have been delivered.) Every public loader (the verdict page,
// loadVerdict, loadReview, latest results) reads its answer here.
export function extensionReportPublished(run: { targetKind: string; status: string; verdict: string | null }): boolean {
  if (run.status === "failed") return false;
  return run.targetKind !== "extension" || Boolean(run.verdict && ["completed", "partial"].includes(run.status));
}
