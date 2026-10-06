import { PAINS } from "@/lib/home-copy";

// The four pains from the research, each in the audience's words (CHE-421):
// the fear as they say it, what the check does about it, what they get. Two
// columns from 640px, one below; the text wraps, nothing scrolls sideways.
// Server component — words from src/lib/home-copy.ts, no state, no script.
export function HomePains() {
  return (
    <section aria-labelledby="home-pains" className="w-full max-w-4xl">
      <h2 id="home-pains" className="section-label mb-6 text-center">
        What people come here afraid of
      </h2>
      <ul className="grid gap-4 sm:grid-cols-2">
        {PAINS.map((pain) => (
          <li key={pain.fear} className="card flex flex-col gap-3 p-6">
            <p className="text-balance text-lg font-semibold leading-snug tracking-tight text-fg">{pain.fear}</p>
            <p className="text-sm leading-6 text-fg-muted">{pain.check}</p>
            <p className="mt-auto border-t border-ink-700 pt-3 text-sm leading-6 text-fg">{pain.get}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
