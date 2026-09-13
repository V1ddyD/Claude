import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The deployment configuration, checked rather than trusted.
 *
 * Two of these get silently or expensively wrong:
 *
 *   the region — naming the wrong one costs half a second on every database
 *   round trip, and nothing reports it; the site is simply slow, and a booking
 *   that makes thirty of them runs out of function time.
 *
 *   the cron expression — Vercel's free plan REJECTS THE DEPLOYMENT for any
 *   schedule that would run more than once a day, so `*​/5 * * * *` here does
 *   not mean a busy worker, it means no deploy at all.
 *
 * Both are one line in a JSON file that nothing else reads, which is exactly
 * the kind of line that drifts.
 */

const vercel = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
  regions?: string[];
  crons?: { path: string; schedule: string }[];
};
const netlify = readFileSync('netlify.toml', 'utf8');

/** Vercel's region codes are its own; these are the AWS regions behind them. */
const AWS_REGION: Record<string, string> = {
  sin1: 'ap-southeast-1',
  iad1: 'us-east-1',
  cle1: 'us-east-2',
  hnd1: 'ap-northeast-1',
  syd1: 'ap-southeast-2',
  fra1: 'eu-central-1',
  lhr1: 'eu-west-2',
};

describe('the function region', () => {
  it('is pinned to exactly one region', () => {
    // The free plan allows one. Asking for more fails the deploy before it
    // reaches the build step, which reads as a build error rather than a
    // plan limit.
    expect(vercel.regions).toHaveLength(1);
  });

  it('is a region Vercel actually has', () => {
    expect(Object.keys(AWS_REGION)).toContain(vercel.regions![0]);
  });

  it('names the same place both hosts are configured for', () => {
    // Whichever host this repository is deployed to, the functions are meant
    // to sit next to the same database. If these two disagree, one of them is
    // a continent away from it.
    const onVercel = AWS_REGION[vercel.regions![0]!];
    const onNetlify = netlify.match(/^\s*region\s*=\s*"([^"]+)"/m)?.[1];

    expect(onNetlify, 'netlify.toml declares no function region').toBeDefined();
    expect(onVercel).toBe(onNetlify);
  });
});

describe('the scheduled worker', () => {
  const schedules = (vercel.crons ?? []).map((c) => c.schedule);

  it('is scheduled', () => {
    expect(vercel.crons?.map((c) => c.path)).toContain('/api/cron/worker');
  });

  it('runs at most once a day, which is all the free plan deploys', () => {
    for (const schedule of schedules) {
      const [minute, hour] = schedule.split(' ');
      // A step or a wildcard in either field means more than one run a day.
      expect
        .soft(/^\d+$/.test(minute ?? ''), `minute field "${minute}" runs more than daily`)
        .toBe(true);
      expect
        .soft(/^\d+$/.test(hour ?? ''), `hour field "${hour}" runs more than daily`)
        .toBe(true);
    }
  });

  it('is driven more often than daily by something that can be', () => {
    // The daily cron is a backstop. Queued confirmation emails and follow-up
    // tasks cannot wait until tomorrow, so a schedule outside the host drives
    // the real cadence.
    const workflow = readFileSync('.github/workflows/worker.yml', 'utf8');
    expect(workflow).toMatch(/cron:\s*'\*\/\d+ \* \* \* \*'/);
    expect(workflow).toContain('/api/cron/worker');
  });

  it('answers the method a platform scheduler sends', () => {
    // Vercel's cron issues a GET. A route with only POST returns 405 to it,
    // and the queue quietly stops draining.
    const route = readFileSync('src/app/api/cron/worker/route.ts', 'utf8');
    expect(route).toMatch(/export async function GET\b/);
    expect(route).toMatch(/export async function POST\b/);
  });
});
