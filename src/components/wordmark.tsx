// The CheckMyApp logo (owner, 2026-10-13): the name as one lowercase word in
// the site's own display face at its heaviest, with only the y in the accent.
// No separate icon. Where there is no room for the word, the y stands alone,
// as it does in the tab (src/app/icon.svg) and on the link preview
// (scripts/make-og-image.mjs, which draws the same word from its outline).
export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <span className={`font-sans font-extrabold leading-none tracking-[-0.045em] text-fg ${className}`}>
      checkm<span className="text-accent">y</span>app
    </span>
  );
}

export function WordmarkY({ className = "" }: { className?: string }) {
  return <span className={`font-sans font-extrabold leading-none text-accent ${className}`}>y</span>;
}
