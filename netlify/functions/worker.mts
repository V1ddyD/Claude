import type { Config } from '@netlify/functions';

/**
 * The scheduler, on Netlify.
 *
 * Netlify has no cron block, so the schedule lives in a function that calls
 * the same route Vercel's cron calls. The work itself stays in the
 * application: a platform-specific scheduler that also contained the logic
 * would be a second implementation to keep in step.
 *
 * The route authenticates with CRON_SECRET. Without it the route returns 503
 * and this logs it rather than failing silently — a queue nobody drains means
 * no confirmation emails and no follow-up tasks, which is worth noticing.
 */
export default async function handler(): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('[worker] CRON_SECRET is not set; the job queue is not being drained.');
    return new Response('CRON_SECRET is not configured', { status: 503 });
  }

  const base = process.env.URL ?? process.env.DEPLOY_URL;
  if (!base) {
    console.error('[worker] No site URL available from the Netlify environment.');
    return new Response('Site URL unavailable', { status: 503 });
  }

  const response = await fetch(new URL('/api/cron/worker', base), {
    method: 'POST',
    headers: { authorization: `Bearer ${secret}` },
  });

  const body = await response.text();
  if (!response.ok) {
    console.error(`[worker] ${response.status} ${body}`);
    return new Response(body, { status: response.status });
  }

  console.log(`[worker] ${body}`);
  return new Response(body, { status: 200 });
}

export const config: Config = { schedule: '*/5 * * * *' };
