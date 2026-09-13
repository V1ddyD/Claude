/**
 * The assistant's replies, rendered.
 *
 * Used by the chat panel and by the transcript on a lead, which is the same
 * text read by a different person — a salesperson scrolling a conversation
 * should not have to read around the asterisks either.
 *
 * The assistant writes light markdown — bold for anything the customer is
 * being asked to choose between, and lists for ranges, colours, trims and
 * offered times. The panel used to print that literally, so a customer reading
 * about the range saw `- **Core** — from $56,400` with the asterisks in it.
 *
 * This renders exactly the three things the assistant actually produces, and
 * nothing else. Deliberately not a markdown library: everything unrecognised
 * stays literal text, and nothing here builds HTML from a string, so a
 * customer's own words coming back in a reply cannot become markup.
 */

/** `**bold**`, and everything else exactly as written. */
function inline(text: string, keyPrefix: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const pattern = /\*\*([^*]+)\*\*/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    parts.push(
      <strong key={`${keyPrefix}-b${match.index}`} className="font-medium text-ink-900">
        {match[1]}
      </strong>,
    );
    cursor = match.index + match[0].length;
  }

  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

type Block =
  | { kind: 'paragraph'; lines: string[] }
  | { kind: 'bullets'; items: string[] }
  | { kind: 'steps'; items: string[] };

const BULLET = /^[-*]\s+(.*)$/;
const STEP = /^\d+\.\s+(.*)$/;

/**
 * Lines into blocks.
 *
 * Consecutive list lines gather into one list; a blank line ends whatever is
 * open. A list that follows a line of prose ("Paint:") stays a separate block,
 * which is what makes the colours read as a list under a label rather than one
 * run-on paragraph.
 */
function toBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let open: Block | null = null;

  const close = () => {
    if (open) blocks.push(open);
    open = null;
  };

  for (const line of text.split('\n')) {
    const trimmed = line.trim();

    if (trimmed.length === 0) {
      close();
      continue;
    }

    const bullet = BULLET.exec(trimmed);
    if (bullet) {
      if (open?.kind !== 'bullets') {
        close();
        open = { kind: 'bullets', items: [] };
      }
      open.items.push(bullet[1]!);
      continue;
    }

    const step = STEP.exec(trimmed);
    if (step) {
      if (open?.kind !== 'steps') {
        close();
        open = { kind: 'steps', items: [] };
      }
      open.items.push(step[1]!);
      continue;
    }

    if (open?.kind !== 'paragraph') {
      close();
      open = { kind: 'paragraph', lines: [] };
    }
    open.lines.push(trimmed);
  }

  close();
  return blocks;
}

export function RichText({ text }: { text: string }) {
  const blocks = toBlocks(text);

  return (
    <div className="space-y-2.5">
      {blocks.map((block, index) => {
        if (block.kind === 'bullets') {
          return (
            <ul key={index} className="space-y-1.5">
              {block.items.map((item, i) => (
                <li key={i} className="flex gap-2.5">
                  <span aria-hidden className="mt-[0.6em] h-1 w-1 shrink-0 rounded-full bg-ink-300" />
                  <span className="flex-1">{inline(item, `${index}-${i}`)}</span>
                </li>
              ))}
            </ul>
          );
        }

        if (block.kind === 'steps') {
          return (
            <ol key={index} className="space-y-1.5">
              {block.items.map((item, i) => (
                <li key={i} className="flex gap-2.5">
                  <span className="w-4 shrink-0 tabular-nums text-ink-500">{i + 1}.</span>
                  <span className="flex-1">{inline(item, `${index}-${i}`)}</span>
                </li>
              ))}
            </ol>
          );
        }

        return (
          <p key={index}>
            {block.lines.map((line, i) => (
              <span key={i}>
                {i > 0 && <br />}
                {inline(line, `${index}-${i}`)}
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}

/**
 * The same reply as speech.
 *
 * The live region is what a screen reader announces, and it was given the raw
 * text — so a blind customer asking about the range heard "dash asterisk
 * asterisk Core asterisk asterisk em dash from fifty-six thousand four
 * hundred". The markers are visual; they carry nothing when read aloud.
 *
 * List structure is dropped rather than translated: the rendered list already
 * carries it for anyone navigating the message itself, and "bullet, bullet,
 * bullet" through an announcement is noise.
 */
export function plainText(text: string): string {
  return toBlocks(text)
    .map((block) =>
      block.kind === 'paragraph'
        ? block.lines.map(strip).join(' ')
        : block.items.map(strip).join('. '),
    )
    .join(' ');
}

function strip(line: string): string {
  return line.replace(/\*\*([^*]+)\*\*/g, '$1');
}
