import Link from "next/link";

// A sidebar item whose page is not built yet (CHE-351). It says what will be
// here and where the same facts live today, so the item is never a dead end.
// Which ticket builds it is a fact for us, kept in the page's own comment —
// never in what a customer reads.
export function PageSoon({
  title,
  what,
  meanwhile,
}: {
  title: string;
  what: string;
  meanwhile: { text: string; href: string; label: string };
}) {
  return (
    <main className="mx-auto w-full max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <div className="card mt-6 p-6">
        <p className="text-sm text-fg">{what}</p>
        <p className="mt-2 text-sm text-fg-muted">
          {meanwhile.text}{" "}
          <Link href={meanwhile.href} className="text-accent hover:underline">
            {meanwhile.label}
          </Link>
        </p>
      </div>
    </main>
  );
}
