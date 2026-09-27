// Did the number move, or did it wobble? (CHE-241)
//
// This is the level Watch is being raised to. Today it says "nothing is
// broken". Tomorrow it says "nothing is broken, and the journey that makes you
// money converted twelve points worse than its own baseline." That is a product
// problem rather than an outage, and nobody else is going to tell them.
//
// Which makes the false positive the expensive failure here, not the false
// negative. An alert that fires on noise teaches the owner to ignore the
// channel, and then the one that matters arrives in a channel nobody reads —
// CHE-109 is the same lesson in a different column. So the bar is deliberately
// two bars, and a movement must clear BOTH:
//
//   1. **Statistically real.** Two proportions from samples of different sizes
//      differ by chance all the time. 40% of 50 and 32% of 50 is an eight-point
//      "drop" that a coin could produce. A two-proportion z-test asks whether
//      this difference is bigger than the noise these sample sizes imply.
//
//   2. **Materially large.** With a big enough sample, a 0.4-point move is
//      statistically certain and worth nobody's morning. Significance answers
//      "is it real"; materiality answers "does it matter". Either one alone
//      sends the wrong email.
//
// The baseline is the journey's OWN trailing history (CHE-239's points), never
// a number someone configured: an app's normal is whatever that app has been
// doing, and a threshold set by hand is a threshold nobody revisits.

export interface MetricPoint {
  conversion: number | null;
  sampleSize: number;
  measuredAt: Date;
}

export interface Proportion {
  /** 0-100. */
  conversion: number;
  /** People the percentage is of. */
  sample: number;
}

/** Points that must exist before a baseline means anything. */
export const MIN_BASELINE_POINTS = 3;
/** Percentage points. Below this, real but not worth an owner's attention. */
export const MATERIAL_POINTS = 5;
/** Two-sided 95%. Chosen, not inherited: one in twenty false alarms is the most
 *  a channel can carry before people start skipping it. */
export const Z_95 = 1.96;

export type Movement =
  | { kind: "fell"; from: Proportion; to: Proportion; points: number; z: number }
  | { kind: "rose"; from: Proportion; to: Proportion; points: number; z: number }
  /** Real difference, too small to act on. */
  | { kind: "immaterial"; from: Proportion; to: Proportion; points: number; z: number }
  /** Inside the noise these sample sizes imply. */
  | { kind: "noise"; from: Proportion; to: Proportion; points: number; z: number }
  /** Not enough history, or no usable current number. */
  | { kind: "no_baseline" };

/**
 * The journey's own normal: its trailing measured points, pooled.
 *
 * Pooled rather than averaged, because a week with 2,000 visitors says more
 * about normal than a week with 40, and averaging the percentages would let the
 * quiet week shout as loudly as the busy one.
 *
 * `points` newest first. The newest is excluded — it is the thing being judged,
 * and a baseline that contains the value it is compared against drags itself
 * toward that value and hides exactly the movement worth reporting.
 */
export function baselineOf(points: readonly MetricPoint[]): Proportion | null {
  const measured = points.filter((p) => p.conversion !== null && p.sampleSize > 0);
  const history = measured.slice(1);
  if (history.length < MIN_BASELINE_POINTS) return null;

  const sample = history.reduce((s, p) => s + p.sampleSize, 0);
  if (sample <= 0) return null;
  // Reconstruct finishers per point, so a big week weighs like a big week.
  const finishers = history.reduce((s, p) => s + (p.conversion! / 100) * p.sampleSize, 0);
  return { conversion: (finishers / sample) * 100, sample };
}

/**
 * The two-proportion z statistic.
 *
 * Exported because it is the part a reader will want to check, and because a
 * statistic nobody can inspect is a statistic nobody should trust.
 */
export function zScore(a: Proportion, b: Proportion): number {
  const p1 = a.conversion / 100;
  const p2 = b.conversion / 100;
  const n1 = a.sample;
  const n2 = b.sample;
  if (n1 <= 0 || n2 <= 0) return 0;
  const pooled = (p1 * n1 + p2 * n2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  // Everyone converting, or nobody, in both samples: no variance, no movement.
  if (!Number.isFinite(se) || se === 0) return 0;
  return (p2 - p1) / se;
}

/**
 * What happened to this journey's conversion.
 *
 * `points` newest first, as CHE-239 stores them. The newest measured point is
 * "now"; everything before it is the baseline.
 */
export function movementOf(points: readonly MetricPoint[]): Movement {
  const measured = points.filter((p) => p.conversion !== null && p.sampleSize > 0);
  const current = measured[0];
  const from = baselineOf(points);
  if (!current || !from) return { kind: "no_baseline" };

  const to: Proportion = { conversion: current.conversion!, sample: current.sampleSize };
  const points_ = Math.round((to.conversion - from.conversion) * 10) / 10;
  const z = zScore(from, to);

  if (Math.abs(z) < Z_95) return { kind: "noise", from, to, points: points_, z };
  if (Math.abs(points_) < MATERIAL_POINTS) return { kind: "immaterial", from, to, points: points_, z };
  return points_ < 0
    ? { kind: "fell", from, to, points: points_, z }
    : { kind: "rose", from, to, points: points_, z };
}

/** The two ends of the path the numbers were counted along. */
export interface MeasuredPath {
  from: string;
  to: string;
}

/** "1 point" / "2 points" — a sentence that miscounts its own unit reads as sloppy. */
function points(n: number): string {
  return `${n} ${n === 1 ? "point" : "points"}`;
}

/**
 * The sentence the owner reads, or null when there is nothing to say.
 *
 * Direction is deliberately not symmetric in tone. A fall is a warning: it
 * names the journey, the movement and what it moved from, because that is what
 * someone needs in order to go and look. A rise gets one sentence and no alarm
 * — it is good news and good news does not need a siren.
 *
 * It says what moved along the path, not that fewer people "finished" (CHE-279).
 * The movement itself is sound either way — both readings count the same two
 * pages a fortnight apart — but the funnel's first stage is where our walk
 * entered the app, so the people in the denominator are everyone who arrived,
 * not everyone who set out to do this journey. "Finishing for fewer people" is
 * therefore a claim the count does not carry, and this sentence is emailed.
 *
 * `path` is required rather than optional on purpose: a caller who has not got
 * the two page names cannot accidentally send the older, shorter sentence.
 *
 * Rule 1: the customer's product only. Nothing about how we measured, and never
 * a request that they go and verify it.
 */
export function movementSentence(
  journeyTitle: string,
  m: Movement,
  path: MeasuredPath,
): string | null {
  // CHE-321: the sentence prints both percentages rounded, so the gap it names
  // is the gap between THOSE two numbers. Stated from the unrounded values it
  // could read "36% … against 30% before — 5.2 points down", which is arithmetic
  // a reader can see is wrong. `m.points` keeps its precision for the judgement
  // above; this is only what the sentence may say.
  if (m.kind !== "fell" && m.kind !== "rose") return null;
  const now = Math.round(m.to.conversion);
  const before = Math.round(m.from.conversion);
  const gap = Math.abs(now - before);
  if (m.kind === "fell") {
    return (
      `“${journeyTitle}” — fewer people are getting from ${path.from} to ${path.to}: ` +
      `${now}% of ${m.to.sample.toLocaleString("en-US")}, ` +
      `against ${before}% before — ${points(gap)} down.`
    );
  }
  return (
    `“${journeyTitle}” — more people are getting from ${path.from} to ${path.to}: ` +
    `${now}% of ${m.to.sample.toLocaleString("en-US")}, ` +
    `up ${points(gap)} on its own recent average of ${before}%.`
  );
}

/** Does this movement deserve the Watch's attention, or only its page? */
export function isAlertable(m: Movement): boolean {
  return m.kind === "fell";
}
