import { describe, it, expect } from 'vitest';
import { changedFields } from '../../src/server/services/audit';

describe('audit diffing', () => {
  it('records only what changed', () => {
    const before = { status: 'new', priority: 'low', assignedStaffId: null };
    const diff = changedFields(before, { status: 'contacted', priority: 'low' });
    expect(diff).toEqual({ before: { status: 'new' }, after: { status: 'contacted' } });
  });

  it('returns null when nothing changed, so no audit row is written', () => {
    const before = { status: 'new', priority: 'low' };
    expect(changedFields(before, { status: 'new' })).toBeNull();
  });

  it('ignores undefined, which means "not supplied" rather than "cleared"', () => {
    const before = { status: 'new', lostReason: 'price' };
    expect(changedFields(before, { lostReason: undefined })).toBeNull();
  });

  it('treats an explicit null as a real change', () => {
    // Typed as nullable because the column is: unassigning a lead sets NULL,
    // and the diff must record that rather than treat it as "not supplied".
    const before: { assignedStaffId: string | null } = { assignedStaffId: 'abc' };
    expect(changedFields(before, { assignedStaffId: null })).toEqual({
      before: { assignedStaffId: 'abc' },
      after: { assignedStaffId: null },
    });
  });
});
