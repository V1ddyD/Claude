import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { RichText, plainText } from '../../src/components/rich-text';

/**
 * What the customer actually reads.
 *
 * The assistant writes markdown and the panel printed it literally, so a
 * customer asking about the range was shown `- **Core** — from $56,400`,
 * asterisks and all. These are the three forms it really produces, taken from
 * live replies, plus the cases where a renderer would be tempted to invent
 * markup that was never there.
 */
const render = (text: string) => renderToStaticMarkup(<RichText text={text} />);

describe('what the assistant writes', () => {
  it('makes bold text bold instead of showing asterisks', () => {
    const html = render('About **$1,035 a month** over 60 months at 6.49% APR.');
    expect(html).toContain('<strong');
    expect(html).toContain('$1,035 a month');
    expect(html).not.toContain('**');
  });

  it('turns a dashed list into a list', () => {
    const html = render('- **Core** — from $56,400\n- **Premium** — from $58,900');
    expect(html).toContain('<ul');
    expect((html.match(/<li/g) ?? []).length).toBe(2);
    expect(html).not.toContain('- **');
  });

  it('turns offered times into a numbered list', () => {
    const html = render('1. Monday at 9:00 a.m.\n2. Monday at 10:00 a.m.');
    expect(html).toContain('<ol');
    expect((html.match(/<li/g) ?? []).length).toBe(2);
  });

  it('keeps a label above its list rather than running them together', () => {
    const html = render('Paint:\n- **Obsidian Black** (metallic)\n- **Glacier White** (pearl)');
    expect(html).toContain('<p');
    expect(html).toContain('Paint:');
    expect(html).toContain('<ul');
  });

  it('separates paragraphs', () => {
    const html = render('First thing.\n\nSecond thing.');
    expect((html.match(/<p/g) ?? []).length).toBe(2);
  });
});

describe('what it must not do', () => {
  it('never builds markup out of the text', () => {
    // A customer's own words can come back in a reply. Nothing here may become
    // an element.
    const html = render('My name is <script>alert(1)</script> & co.');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('leaves unmatched asterisks alone rather than guessing', () => {
    const html = render('A 5** rating');
    expect(html).toContain('5** rating');
    expect(html).not.toContain('<strong');
  });

  it('does not treat a price or a date as a numbered list', () => {
    const html = render('$52,900. Available now.');
    expect(html).not.toContain('<ol');
  });

  it('renders nothing for an empty reply rather than an empty box', () => {
    expect(render('')).not.toContain('<p');
  });
});

describe('what a screen reader is given', () => {
  /**
   * The live region announces the finished reply. It used to be handed the raw
   * text, so a blind customer asking about the range heard "dash asterisk
   * asterisk Core asterisk asterisk em dash from fifty-six thousand".
   */
  it('says the words without the markers', () => {
    const spoken = plainText('- **Core** — from $56,400\n- **Premium** — from $58,900');
    expect(spoken).not.toContain('*');
    expect(spoken).not.toMatch(/(^|\s)-\s/);
    expect(spoken).toContain('Core');
    expect(spoken).toContain('Premium');
  });

  it('keeps a label with the list it introduces', () => {
    const spoken = plainText('Paint:\n- **Obsidian Black** (metallic)');
    expect(spoken).toContain('Paint:');
    expect(spoken).toContain('Obsidian Black (metallic)');
  });

  it('separates list items so they are not run together', () => {
    expect(plainText('- One\n- Two')).toBe('One. Two');
  });

  it('says nothing for an empty reply', () => {
    expect(plainText('')).toBe('');
  });
});
