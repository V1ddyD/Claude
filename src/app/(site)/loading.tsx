/**
 * Shown while a page's data is fetched.
 *
 * A skeleton of the shape that is coming, rather than a spinner: the page does
 * not jump when the content lands.
 */
export default function SiteLoading() {
  return (
    <main className="mx-auto max-w-6xl px-6 py-20" aria-busy="true" aria-label="Loading">
      <div className="h-3 w-24 animate-pulse rounded bg-ink-100" />
      <div className="mt-6 h-10 w-2/3 animate-pulse rounded bg-ink-100" />
      <div className="mt-4 h-4 w-1/2 animate-pulse rounded bg-ink-100" />
      <div className="mt-10 grid gap-px bg-ink-100 sm:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="bg-ink-50 p-6">
            <div className="aspect-[16/10] w-full animate-pulse rounded bg-ink-100" />
            <div className="mt-5 h-4 w-1/2 animate-pulse rounded bg-ink-100" />
            <div className="mt-2 h-3 w-1/3 animate-pulse rounded bg-ink-100" />
          </div>
        ))}
      </div>
    </main>
  );
}
