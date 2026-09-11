/**
 * Customer homepage placeholder.
 *
 * The real Sinclair site is M4. This exists so the root route resolves during
 * M1 and is deliberately not dressed up as a finished page — a scaffold that
 * looks complete but is wired to nothing is the thing spec §60 warns against.
 */
export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-6">
      <p className="text-xs uppercase tracking-[0.25em] text-ink-500">Sinclair</p>
      <h1 className="mt-4 text-3xl font-medium tracking-tight text-ink-900">
        Customer site — not yet built
      </h1>
      <p className="mt-4 text-ink-500">
        The foundation is in place: schema, tenant isolation, authorization and audit.
        The catalogue lands in M2, the assistant and this site in M3 and M4.
      </p>
      <a
        href="/portal"
        className="mt-8 w-fit border-b border-ink-900 pb-0.5 text-sm text-ink-900 hover:border-accent-500 hover:text-accent-500"
      >
        Dealer Portal
      </a>
    </main>
  );
}
