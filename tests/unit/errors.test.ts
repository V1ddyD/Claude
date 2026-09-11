import { describe, it, expect } from 'vitest';
import { AppError, toPublicError, forbidden, notFound } from '../../src/server/errors';

describe('public error shape', () => {
  it('never carries internal detail to the client', () => {
    const err = new AppError('CONFLICT', 'That time is no longer available.', {
      internal: { query: 'SELECT * FROM appointments', stack: 'secret' },
      data: { alternatives: ['10:00', '13:30'] },
    });

    const published = toPublicError(err);
    expect(published).toEqual({
      code: 'CONFLICT',
      message: 'That time is no longer available.',
      data: { alternatives: ['10:00', '13:30'] },
    });
    expect(JSON.stringify(published)).not.toContain('SELECT');
    expect(JSON.stringify(published)).not.toContain('secret');
  });

  it('reduces unexpected errors to a generic message', () => {
    const published = toPublicError(new Error('connect ECONNREFUSED 10.0.0.4:5432'));
    expect(published.code).toBe('INTERNAL');
    expect(published.message).not.toContain('ECONNREFUSED');
    expect(published.message).not.toContain('10.0.0.4');
  });

  it('does not distinguish forbidden from not found in its wording', () => {
    // Saying "you may not see this" confirms the record exists, which tells a
    // probing caller which ids are real in another tenant.
    expect(forbidden().message).not.toMatch(/exist|found|permission|role/i);
    expect(notFound('Lead').status).toBe(404);
  });
});
