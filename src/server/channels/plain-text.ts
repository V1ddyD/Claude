/**
 * Markdown out, plain text in.
 *
 * The assistant writes markdown, because the website renders it: `**Premium**`
 * becomes bold in the chat panel and in the portal transcript.
 *
 * Instagram and Messenger render nothing. A direct message is plain text, so
 * every one of those asterisks is shown to the customer exactly as typed:
 *
 *     - **Premium** Dual Motor AWD Long Range — $68,900
 *
 * which is not emphasis, it is litter, and it makes a reply look like
 * something a machine forgot to finish.
 *
 * So the conversion happens HERE, at the channel boundary, rather than by
 * teaching the assistant to write differently. The assistant has one voice and
 * one output; each surface renders it the way that surface can. Change this
 * file and every channel changes with it, while the website and the portal —
 * which render markdown perfectly well — are untouched.
 *
 * It is deliberately not a markdown parser. It handles the three things this
 * assistant actually writes, and anything else passes through unharmed.
 */

/**
 * The bullet a direct message can actually show.
 *
 * A leading "-" is a markdown list marker that nothing on Instagram turns into
 * a list, so it just reads as a stray dash at the start of every line. A real
 * bullet character needs no rendering to look like a bullet.
 */
const BULLET = '•';

export function toPlainText(markdown: string): string {
  return markdown
    .split('\n')
    .map(convertLine)
    .join('\n')
    // Three or more blank lines can survive the per-line work; nobody wants a
    // message with a hole in the middle of it.
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function convertLine(line: string): string {
  const indent = /^(\s*)/.exec(line)?.[1] ?? '';
  let text = line.trim();

  // A list marker, which is the only place a leading dash is punctuation
  // rather than part of a word. "- **Core** ..." becomes "• Core ...".
  const bulleted = /^[-*]\s+(.*)$/.exec(text);
  if (bulleted) text = `${BULLET} ${bulleted[1]}`;

  // Headings, in case one is ever written. The text is the useful part.
  text = text.replace(/^#{1,6}\s+/, '');

  return indent + emphasis(text);
}

/**
 * Strip the emphasis markers, keep the words.
 *
 * Bold first: `**x**` would otherwise be read as an italic `*` around `*x*`
 * and leave a stray asterisk at each end.
 *
 * Both patterns require the content to be non-empty and to contain no marker
 * of its own, so a lone asterisk in ordinary prose — a footnote, a multiply
 * sign, somebody typing `2 * 3` — is left exactly as the customer wrote it.
 */
function emphasis(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(?<![*\w])\*([^*\n]+)\*(?!\w)/g, '$1');
}
