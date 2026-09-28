// The rule the executor's waits are moving to: a slow page is not a broken
// one, and a quiet page will not become a working one because we waited
// longer (extension-runner/progress.mjs).
//
// Checked against a fake page rather than a browser, because what matters is
// the decision — succeed, "went quiet", or "still busy at the ceiling" — and
// that decision is pure. The real browser behaviour it stands on is Playwright
// emitting response/framenavigated events and MutationObserver firing, both of
// which are exercised for real in the live runs.
//
// Usage: node scripts/verify-progress-waiting.mjs

import assert from 'node:assert/strict';
import { waitForProgress } from '../extension-runner/progress.mjs';

// The satisfying timer below starts before waitForProgress starts its own
// clock, so `result.ms` can read a few ms under the timer's delay (seen in CI,
// 2026-09-28: 349 against 350). What these cases prove is that the wait went
// far past idleMs because the page kept working — not the timer's exactness.
const TIMER_SLACK_MS = 30;

// A page double: records handlers, lets a test emit activity, and serves the
// DOM-mutation counter progress.mjs reads back through evaluate().
function fakePage({ domMutations = () => 0 } = {}) {
  const handlers = new Map();
  return {
    mutations: domMutations,
    on(event, fn) { handlers.set(event, [...(handlers.get(event) ?? []), fn]); },
    off(event, fn) { handlers.set(event, (handlers.get(event) ?? []).filter(h => h !== fn)); },
    emit(event) { for (const fn of handlers.get(event) ?? []) fn(); },
    async evaluate(fn) {
      // The install call returns true; the read call returns the counter.
      const source = String(fn);
      if (source.includes('MutationObserver')) return true;
      if (source.includes('__cmaProgress')) return { count: this.mutations(), at: Date.now() };
      return null;
    },
    async waitForTimeout(ms) { await new Promise(resolve => setTimeout(resolve, ms)); },
    handlerCount() { return [...handlers.values()].reduce((sum, list) => sum + list.length, 0); },
  };
}

// 1. A condition that is already true returns at once and reports its cost.
{
  const page = fakePage();
  const result = await waitForProgress(page, async () => true, { idleMs: 50, ceilingMs: 500, pollMs: 10 });
  assert.ok(result.ms < 200, 'An already-satisfied condition must not wait');
  assert.equal(page.handlerCount(), 0, 'Listeners are removed even on the success path');
}

// 2. Slow but alive: the condition needs far longer than idleMs, and network
// activity keeps arriving. This is the container that is merely 3.4x slower —
// it must pass, which a fixed idleMs-sized timeout would not have allowed.
{
  const page = fakePage();
  let satisfied = false;
  const beat = setInterval(() => page.emit('response'), 20);
  setTimeout(() => { satisfied = true; }, 400);
  const result = await waitForProgress(page, async () => satisfied, { idleMs: 100, ceilingMs: 5000, pollMs: 10 });
  clearInterval(beat);
  assert.ok(result.ms >= 400 - TIMER_SLACK_MS, 'A live page is waited on for as long as it keeps working');
  assert.ok(result.requests > 0, 'Responses count as progress');
}

// 3. DOM mutation alone is progress. Hydration and client-side routing finish
// after the last response, and a page finishing its render is not stuck.
{
  let count = 0;
  const page = fakePage({ domMutations: () => count });
  let satisfied = false;
  const beat = setInterval(() => { count += 3; }, 20);
  setTimeout(() => { satisfied = true; }, 350);
  const result = await waitForProgress(page, async () => satisfied, { idleMs: 100, ceilingMs: 5000, pollMs: 10 });
  clearInterval(beat);
  assert.ok(result.ms >= 350 - TIMER_SLACK_MS, 'Mutations keep the wait alive well past idleMs');
  assert.ok(result.mutations > 0, 'DOM changes count as progress without any network traffic');
}

// 4. Quiet and unsatisfied: this is the only real failure, and it is named as
// such — the page stopped doing anything, so waiting longer changes nothing.
{
  const page = fakePage();
  await assert.rejects(
    waitForProgress(page, async () => false, { idleMs: 120, ceilingMs: 10_000, pollMs: 10, what: 'the minute balance' }),
    /Waited for the minute balance: the page went quiet .* never appeared/,
  );
  assert.equal(page.handlerCount(), 0, 'Listeners are removed on the failure path too');
}

// 5. Busy forever: the ceiling is the backstop, and it says something
// different from going quiet, because a page that never stops working is a
// different finding from one that stopped.
{
  const page = fakePage();
  const beat = setInterval(() => page.emit('response'), 10);
  await assert.rejects(
    waitForProgress(page, async () => false, { idleMs: 1000, ceilingMs: 250, pollMs: 10, what: 'Start call' }),
    /Waited for Start call: still busy after .* treated as stuck at the ceiling/,
  );
  clearInterval(beat);
}

// 6. A page that cannot be evaluated (navigating, closed) still waits on
// network progress instead of throwing — losing the DOM signal must not turn
// a slow page into a failed one.
{
  const page = fakePage();
  page.evaluate = async () => { throw new Error('Execution context was destroyed'); };
  let satisfied = false;
  const beat = setInterval(() => page.emit('framenavigated'), 20);
  setTimeout(() => { satisfied = true; }, 300);
  const result = await waitForProgress(page, async () => satisfied, { idleMs: 100, ceilingMs: 5000, pollMs: 10 });
  clearInterval(beat);
  assert.ok(result.ms >= 300, 'Navigation counts as progress when the DOM cannot be read');
}

console.log('Progress waiting: slow-but-alive waits, quiet fails, busy-forever hits the ceiling, listeners always released');
