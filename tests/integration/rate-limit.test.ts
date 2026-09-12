import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prepareDatabase } from '../helpers/db';
import { closeConnections } from '../../src/server/db/client';
import { checkRateLimit, sweepRateLimits } from '../../src/server/services/limits';

/**
 * The counter in front of the chat endpoint.
 *
 * Worth its own suite because it sits on the request path before anything else
 * runs: the tests below all called the conversation directly, so a statement
 * the driver refused here failed every single HTTP request while the whole
 * suite stayed green.
 */

beforeAll(async () => {
  await prepareDatabase();
});
afterAll(async () => {
  await closeConnections();
});

describe('rate limiting', () => {
  const limit = (subject: string) => ({
    bucket: 'test', subject, max: 3, windowSeconds: 60,
  });

  it('counts, then refuses', async () => {
    const subject = `subject-${crypto.randomUUID()}`;

    const first = await checkRateLimit(limit(subject));
    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(2);

    await checkRateLimit(limit(subject));
    await checkRateLimit(limit(subject));

    const fourth = await checkRateLimit(limit(subject));
    expect(fourth.allowed).toBe(false);
    expect(fourth.remaining).toBe(0);
    expect(fourth.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('counts each subject separately', async () => {
    const one = await checkRateLimit(limit(`subject-${crypto.randomUUID()}`));
    const two = await checkRateLimit(limit(`subject-${crypto.randomUUID()}`));
    expect(one.remaining).toBe(2);
    expect(two.remaining).toBe(2);
  });

  it('sweeps closed windows without touching open ones', async () => {
    const subject = `subject-${crypto.randomUUID()}`;
    await checkRateLimit(limit(subject));

    await sweepRateLimits();

    // The current window survived, so the count carries on rather than resetting.
    const next = await checkRateLimit(limit(subject));
    expect(next.remaining).toBe(1);
  });
});
