import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * A queued job nobody drains.
 *
 * Every chat turn enqueues `extract_and_score`, and that job is what gives a
 * lead its priority and its summary — the two things the portal exists to show
 * a salesperson. Queueing it is only half the arrangement: on a free hosting
 * plan there may be no scheduler at all (Vercel permits a cron once a DAY), so
 * a dealership could open the portal to a list of leads all reading "low
 * priority, no summary" and conclude the product does not work.
 *
 * So the request that creates the work also arranges for it to be done, after
 * the reply has gone out. This is a structural check because the behaviour
 * belongs to the platform's request lifecycle, which the test runner does not
 * have — but deleting either half is a silent failure worth failing a build.
 */
const route = readFileSync('src/app/api/chat/route.ts', 'utf8');

describe('the chat endpoint', () => {
  it('queues the extraction', () => {
    expect(route).toMatch(/enqueue\(\s*db,\s*'extract_and_score'/);
  });

  it('drains the queue once the reply has gone out', () => {
    expect(route).toMatch(/\bafter\(/);
    expect(route).toMatch(/runWorker\(\)/);

    // Inside after(), not on the customer's critical path. A bare runWorker()
    // awaited before the response would make every customer wait for work that
    // is not theirs.
    const inside = /after\(async \(\) => \{[\s\S]*?runWorker\(\)[\s\S]*?\}\);/.test(route);
    expect(inside, 'runWorker must run inside after(), not before the response').toBe(true);
  });

  it('never lets a failed drain reach the customer', () => {
    // The reply is already delivered by then; a queue that failed to drain is
    // an operational problem, not something to show someone buying a car.
    expect(route).toMatch(/after\(async \(\) => \{\s*try \{/);
  });
});
