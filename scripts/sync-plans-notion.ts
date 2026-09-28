// The owner's single page on plans and limits, rewritten from code (CHE-326).
//
// The owner asked for ONE place to read what each plan gets without reading
// code: a Notion page ("CheckMyApp — single source of truth"). A page kept by
// hand is true on the day it is written, so this script owns it instead. It
// renders the body from src/lib/plans.ts (PLAN_LIMITS and the run quotas) and
// src/lib/plan-catalog.ts (the names, prices and lines /pricing shows), then
// replaces the page's blocks — every child deleted, the new ones appended. CI
// runs it after every deploy of main, so the page says what production does.
//
// The "Расхождения" section is computed, not written: planCatalogDrift() lists
// every way the pricing copy disagrees with PLAN_LIMITS, and the section only
// appears while that list is non-empty. scripts/verify-plan-catalog.ts fails
// the build on the same list, so on main it is empty.
//
// Usage:
//   NOTION_TOKEN=… npx tsx --tsconfig tsconfig.json scripts/sync-plans-notion.ts
//   npx tsx --tsconfig tsconfig.json scripts/sync-plans-notion.ts --dry-run
//
// --dry-run prints the blocks as JSON and touches nothing. The commit and date
// in the callout come from GITHUB_SHA (CI) or `git rev-parse HEAD` (local).

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { UserPlan } from "@/lib/enums";
import { toolSchemas } from "@/lib/mcp/tools";
import { PLAN_CATALOG, TRACKER_LINE, balanceLine, priceRangeLine, type CatalogPlan } from "@/lib/plan-catalog";
import {
  ANON_RUNS_PER_DAY,
  ANON_RUNS_PER_DAY_SITE,
  FREE_TRIAL_WATCHES,
  PLAN_LIMITS,
  RUNAWAY_COST_USD,
  TOPUP_AMOUNTS_USD,
  TYPICAL_CHECK_COST_USD,
  WATCH_TRIAL_DAYS,
  typicalPriceRange,
  usd,
} from "@/lib/plans";
import { MAX_EXTRA_ACCOUNTS } from "@/lib/test-accounts";

export const PAGE_ID = "3e97bac6-430a-8108-b34f-cddb4ac1a11a";
const NOTION_API = "https://api.notion.com/v1";
const NOTION_VERSION = "2022-06-28";

// ---------------------------------------------------------------------------
// Drift between the pricing copy and PLAN_LIMITS. Pure; shared with the verify
// script. Each entry is one sentence in Russian, because the page is.

export function planCatalogDrift(catalog: CatalogPlan[] = PLAN_CATALOG): string[] {
  const drift: string[] = [];
  for (const plan of catalog) {
    const limits = PLAN_LIMITS[plan.id];
    const text = plan.features.join("\n");

    if (/nominat/i.test(`${plan.blurb}\n${text}`)) {
      drift.push(`${plan.name}: «nominate» — свои пути (сценарии) есть на любом тарифе, не только у ${plan.name}.`);
    }
    if (limits.trackerIntegration !== plan.features.includes(TRACKER_LINE)) {
      drift.push(
        limits.trackerIntegration
          ? `${plan.name}: трекер в коде включён, а на странице цен не указан.`
          : `${plan.name}: трекер на странице цен обещан, а в коде выключен.`,
      );
    }
    // CHE-327: the balance is the plan. The card must carry the plan's
    // balance line and — on a paid plan — its price range, word for word.
    if (!plan.features.includes(balanceLine(plan.id))) {
      drift.push(`${plan.name}: баланс в коде ${usd(limits.creditUsd ?? 0)}, на странице цен другое или ничего.`);
    }
    if (plan.id !== "free" && !plan.features.includes(priceRangeLine(plan.id))) {
      drift.push(`${plan.name}: на странице цен нет диапазона цены проверки из кода.`);
    }
    if (/full re-check|up to \d+ apps/i.test(text)) {
      drift.push(`${plan.name}: на странице цен остались полные перепроверки или лимит аппов — их больше нет (CHE-327).`);
    }
    const seats = limits.includedSeats;
    if (seats !== null && !new RegExp(`^${seats} (person|people) who can run checks`, "m").test(text)) {
      drift.push(`${plan.name}: мест в коде ${seats}, на странице цен другое число или ничего.`);
    }
    if (plan.id === "free") {
      const want = [
        `${ANON_RUNS_PER_DAY} check/day without signup`,
        `${WATCH_TRIAL_DAYS}-day Daily Watch trial`,
      ];
      for (const w of want) {
        if (!text.includes(w)) drift.push(`Free: на странице цен нет «${w}» (так в коде).`);
      }
    }
  }
  return drift;
}

// ---------------------------------------------------------------------------
// Rendering. Notion blocks as plain objects — the REST shape, nothing more.

type RichText = { type: "text"; text: { content: string } };
type Block = Record<string, unknown> & { object: "block"; type: string };

function rt(content: string): RichText[] {
  return [{ type: "text", text: { content } }];
}
function paragraph(text: string): Block {
  return { object: "block", type: "paragraph", paragraph: { rich_text: rt(text) } };
}
function heading2(text: string): Block {
  return { object: "block", type: "heading_2", heading_2: { rich_text: rt(text) } };
}
function heading3(text: string): Block {
  return { object: "block", type: "heading_3", heading_3: { rich_text: rt(text) } };
}
function bullet(text: string): Block {
  return { object: "block", type: "bulleted_list_item", bulleted_list_item: { rich_text: rt(text) } };
}
function callout(text: string): Block {
  return {
    object: "block",
    type: "callout",
    callout: { rich_text: rt(text), icon: { type: "emoji", emoji: "💡" }, color: "default" },
  };
}
function table(rows: string[][]): Block {
  return {
    object: "block",
    type: "table",
    table: {
      table_width: rows[0].length,
      has_column_header: true,
      has_row_header: true,
      children: rows.map((cells) => ({
        object: "block",
        type: "table_row",
        table_row: { cells: cells.map((c) => rt(c)) },
      })),
    },
  };
}

const UNLIMITED = "без лимита";

function countOrUnlimited(n: number | null): string {
  return n === null || n >= Number.MAX_SAFE_INTEGER ? UNLIMITED : String(n);
}
function priceLabel(plan: CatalogPlan): string {
  return `${plan.price}${plan.priceNote ?? ""}`;
}

// CHE-327: the balance the plan puts on the team, and the window.
function creditCell(plan: UserPlan): string {
  const c = PLAN_LIMITS[plan].creditUsd;
  if (c === null) return UNLIMITED;
  return plan === "free"
    ? `${usd(c)} один раз на команду; без аккаунта ${ANON_RUNS_PER_DAY} проверка/день`
    : `${usd(c)} каждый месяц (UTC), без переноса`;
}

function watchCell(plan: UserPlan): string {
  return plan === "free"
    ? `${FREE_TRIAL_WATCHES}, раз в день, триал ${WATCH_TRIAL_DAYS} дней, потом пауза`
    : "без лимита, раз в день или раз в 6 ч";
}

function rangeCell(plan: UserPlan): string {
  const r = typicalPriceRange(plan);
  return `${usd(r.low)}–${usd(r.high)}`;
}

export type RenderMeta = { sha: string; date: string };

export function renderPlanBlocks(meta: RenderMeta): Block[] {
  const plans = PLAN_CATALOG;
  const ids = plans.map((p) => p.id);
  const row = (label: string, cell: (id: UserPlan) => string) => [label, ...ids.map(cell)];

  const blocks: Block[] = [
    callout(
      `Сгенерировано из кода — руками не править. Страницу переписывает scripts/sync-plans-notion.ts ` +
        `после каждого деплоя main (CHE-326) из src/lib/plans.ts и src/lib/plan-catalog.ts: ` +
        `решение о тарифе → правка кода → страница обновится сама. ` +
        `Коммит ${meta.sha.slice(0, 7)}, ${meta.date}.`,
    ),
    heading2("Что ограничивает тариф (и только это)"),
    table([
      ["", ...plans.map((p) => `${p.name} ${priceLabel(p)}`)],
      row("Баланс (любые проверки: watch, агент, UI, перепроверки)", creditCell),
      row("Множитель цены (ВНУТРЕННЕЕ — клиенту никогда)", (id) => `×${PLAN_LIMITS[id].priceMultiplier}`),
      row("Типичная цена проверки (p50–p90)", rangeCell),
      row("Daily Watch", watchCell),
      row("Места (admin/member), readers бесплатно", (id) => countOrUnlimited(PLAN_LIMITS[id].includedSeats)),
      row("Трекер (Linear)", (id) => (PLAN_LIMITS[id].trackerIntegration ? "да" : "нет")),
    ]),
    paragraph(
      `Цена проверки = её себестоимость × множитель тарифа, списывается с баланса, когда проверка ` +
        `закончилась; упавшая по нашей вине — $0. Себестоимость проверки (30 дней до 2026-09-28): ` +
        `p50 ${usd(TYPICAL_CHECK_COST_USD.low)}, p90 ${usd(TYPICAL_CHECK_COST_USD.high)}; предохранитель — ` +
        `проверка дороже ${usd(RUNAWAY_COST_USD)} себестоимости останавливается как наш сбой. ` +
        `Пополнение: ${TOPUP_AMOUNTS_USD.map((a) => `$${a}`).join(" / ")}, не сгорает, тратится после баланса тарифа.`,
    ),
    paragraph(
      `Сайт целиком: ${ANON_RUNS_PER_DAY_SITE} бесплатных анонимных проверок в сутки ` +
        `(по умолчанию; env ANON_RUNS_PER_DAY_SITE меняет без деплоя), дальше — проверка за $1. ` +
        `Enterprise: баланс ${countOrUnlimited(PLAN_LIMITS.enterprise.creditUsd)}, ` +
        `множитель ×${PLAN_LIMITS.enterprise.priceMultiplier}, ` +
        `мест ${countOrUnlimited(PLAN_LIMITS.enterprise.includedSeats)}.`,
    ),
    heading2("Что НЕ зависит от тарифа (есть везде, включая Free)"),
    bullet("Свои сценарии (focusAreas), границы (scopeHints), заметки."),
    bullet(`Тестовые аккаунты — основной и до ${MAX_EXTRA_ACCOUNTS} именованных (CHE-322).`),
    bullet(
      `API-ключ и MCP со всеми ${Object.keys(toolSchemas).length} инструментами (CHE-316); ` +
        `лимиты — только объёмы из таблицы выше.`,
    ),
    bullet(
      "Число проверок, аппов под watch и частота (для платных) — не лимитированы: всё тратит один баланс (CHE-327).",
    ),
    heading2("Как это сказано на checkmyapp.dev/pricing"),
  ];

  for (const plan of plans) {
    blocks.push(heading3(`${plan.name} — ${priceLabel(plan)}`));
    blocks.push(paragraph(plan.blurb));
    for (const f of plan.features) blocks.push(bullet(f));
  }

  const drift = planCatalogDrift(plans);
  if (drift.length > 0) {
    blocks.push(heading2(`Расхождения страницы цен с кодом (на ${meta.date})`));
    for (const d of drift) blocks.push(bullet(d));
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Notion REST.

async function notion(token: string, method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${NOTION_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Notion ${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

async function childIds(token: string, blockId: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const q = `page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`;
    const page = (await notion(token, "GET", `/blocks/${blockId}/children?${q}`)) as {
      results: { id: string }[];
      has_more: boolean;
      next_cursor: string | null;
    };
    ids.push(...page.results.map((r) => r.id));
    cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
  } while (cursor);
  return ids;
}

export async function replacePage(token: string, pageId: string, blocks: Block[]): Promise<void> {
  // Append first, then delete the old children: if Notion fails halfway, the
  // page holds too much for one deploy rather than nothing.
  const old = await childIds(token, pageId);
  for (let i = 0; i < blocks.length; i += 100) {
    await notion(token, "PATCH", `/blocks/${pageId}/children`, { children: blocks.slice(i, i + 100) });
  }
  for (const id of old) await notion(token, "DELETE", `/blocks/${id}`);
}

function currentSha(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const meta: RenderMeta = { sha: currentSha(), date: new Date().toISOString().slice(0, 10) };
  const blocks = renderPlanBlocks(meta);

  if (dryRun) {
    console.log(JSON.stringify(blocks, null, 2));
    console.log(`\n${blocks.length} blocks, not written (--dry-run)`);
    return;
  }
  const token = process.env.NOTION_TOKEN;
  if (!token) {
    console.error("sync-plans-notion: NOTION_TOKEN is not set");
    process.exit(1);
  }
  await replacePage(token, PAGE_ID, blocks);
  console.log(`sync-plans-notion: wrote ${blocks.length} blocks to page ${PAGE_ID} (commit ${meta.sha.slice(0, 7)})`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(`sync-plans-notion: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
