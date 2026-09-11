export default function PortalLoading() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <div className="h-8 w-64 animate-pulse rounded bg-ink-100" />
      <div className="mt-8 space-y-px overflow-hidden rounded border border-ink-100">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="h-14 animate-pulse bg-white" />
        ))}
      </div>
    </div>
  );
}
