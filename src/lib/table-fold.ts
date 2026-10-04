// A table fits the work area at every width (owner rule, 2026-10-04): it never
// scrolls sideways, and nothing in it runs off the edge. What does not fit
// folds or moves:
//
//   - below the width at which the sidebar stands beside the page (900px,
//     src/components/shell/app-shell.tsx) the rows are drawn as cards, and the
//     table is not drawn at all;
//   - from there up to a wide screen (xl, 1280px) a secondary column is folded
//     into one that stays — the schedule under the app's name, who started a
//     check under when it ran — and from xl on it is a column of its own.
//
// One place for the widths, so every table under src/app/(app) folds at the
// same points and scripts/verify-table-fold.ts can hold each of them to it.
// The names end in ClassName so scripts/verify-class-names.ts reads them.
export const FOLD = {
  tableClassName: "hidden min-[900px]:block",
  cardsClassName: "flex flex-col gap-3 min-[900px]:hidden",
  wideColumnClassName: "hidden xl:table-cell",
  foldedClassName: "xl:hidden",
} as const;

// The table itself: fixed layout, so a column is as wide as its header says
// and a long value truncates inside its cell instead of widening the table past
// its card.
export const TABLE_CLASS = "w-full table-fixed border-collapse text-sm";
