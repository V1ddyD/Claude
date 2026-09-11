import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <h1 className="text-2xl font-medium tracking-tight text-ink-900">
        We could not find that
      </h1>
      <p className="mt-3 leading-relaxed text-ink-500">
        The page, vehicle or request you were looking for is not here. It may have moved,
        or a link may have expired.
      </p>
      <Link
        href="/"
        className="mt-8 w-fit bg-ink-900 px-5 py-2.5 text-sm text-white transition-colors hover:bg-ink-800"
      >
        Back to the homepage
      </Link>
    </main>
  );
}
