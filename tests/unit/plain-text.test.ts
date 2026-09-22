import { describe, it, expect } from 'vitest';
import { toPlainText } from '../../src/server/channels/plain-text';

/**
 * What a direct message actually looks like.
 *
 * Instagram and Messenger render no markup at all, so the assistant's
 * `**Premium**` reached customers with the asterisks still on it. These are
 * the forms it really writes, taken from live replies.
 */

describe('markdown a direct message cannot render', () => {
  it('keeps the word and drops the asterisks', () => {
    expect(toPlainText('**Sinclair S5**: Premium Mid-Size SUV, from $56,400.')).toBe(
      'Sinclair S5: Premium Mid-Size SUV, from $56,400.',
    );
  });

  it('turns a dashed list into one a person can read', () => {
    expect(toPlainText('- **Core**: from $56,400\n- **Premium**: from $58,900')).toBe(
      '• Core: from $56,400\n• Premium: from $58,900',
    );
  });

  it('leaves no marker anywhere in a whole reply', () => {
    const reply = [
      'The **Sinclair R**, up to 700 hp.',
      '',
      'Then:',
      '- **Sinclair E5**: up to 680 hp',
      '- **Sinclair GT**: up to 560 hp',
    ].join('\n');

    const plain = toPlainText(reply);
    expect(plain).not.toContain('*');
    expect(plain).not.toMatch(/^- /m);
    expect(plain).toContain('Sinclair R');
    expect(plain).toContain('• Sinclair E5: up to 680 hp');
  });

  it('keeps the paragraph breaks that make a long reply readable', () => {
    expect(toPlainText('One.\n\nTwo.')).toBe('One.\n\nTwo.');
  });

  it('leaves hyphens inside words alone', () => {
    // "8speed automatic" would be worse than the problem it fixed. These are
    // the dealership's own words, not our punctuation.
    const plain = toPlainText('- **2.0 Turbo AWD**: 2.0L turbocharged inline-4\n  275 hp · 8-speed automatic');
    expect(plain).toContain('inline-4');
    expect(plain).toContain('8-speed automatic');
  });

  it('leaves an asterisk that was never markup', () => {
    expect(toPlainText('Two seats * two rows = four.')).toBe('Two seats * two rows = four.');
  });

  it('does nothing to text that has no markup in it', () => {
    const plain = 'Happy to help. What matters most to you: price, power, or range?';
    expect(toPlainText(plain)).toBe(plain);
  });
});
