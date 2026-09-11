'use client';

import { useEffect } from 'react';

/**
 * The last line of defence.
 *
 * A customer is told something true and given a way forward. They are never
 * shown a stack trace, an error code, or the name of a service (spec §33) —
 * the detail is in the server log, correlated by digest.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Unhandled error', error.digest ?? error.message);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <h1 className="text-2xl font-medium tracking-tight text-ink-900">
        Something went wrong at our end
      </h1>
      <p className="mt-3 leading-relaxed text-ink-500">
        Nothing you did caused this. Try again, and if it keeps happening please call us
        and we will sort it out.
      </p>
      <div className="mt-8 flex gap-3">
        <button
          type="button"
          onClick={reset}
          className="bg-ink-900 px-5 py-2.5 text-sm text-white transition-colors hover:bg-ink-800"
        >
          Try again
        </button>
        <a
          href="/"
          className="border border-ink-100 px-5 py-2.5 text-sm text-ink-900 transition-colors hover:border-ink-300"
        >
          Back to the homepage
        </a>
      </div>
      {error.digest && (
        // An opaque reference, so a customer on the phone can be matched to a
        // log entry without anything about the failure being exposed.
        <p className="mt-8 font-mono text-xs text-ink-300">Reference {error.digest}</p>
      )}
    </main>
  );
}
