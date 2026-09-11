/**
 * Transactional email templates.
 *
 * Plain and factual: a confirmation is a record, not a marketing message. Every
 * template renders both text and HTML from the same content so neither drifts.
 */

export interface TemplateContext {
  brandName: string;
  customerName?: string | null;
  payload: Record<string, unknown>;
  /** Where the single-use link points. Absent in tests and previews. */
  baseUrl?: string;
}

export interface RenderedTemplate {
  subject: string;
  text: string;
  html: string;
}

type Row = [label: string, value: string];

function field(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

const TEMPLATES: Record<
  string,
  (ctx: TemplateContext) => { heading: string; intro: string; rows: Row[]; closing?: string }
> = {
  test_drive_confirmation: ({ brandName, payload }) => ({
    heading: 'Your test drive is booked',
    intro: `We look forward to seeing you at ${brandName}.`,
    rows: [
      ['Reference', field(payload, 'ticketNumber') ?? '—'],
      ['Vehicle', field(payload, 'vehicle') ?? '—'],
      ['When', field(payload, 'when') ?? '—'],
      ['Confirmation code', field(payload, 'confirmationCode') ?? '—'],
    ],
    closing: 'Please bring a valid driving licence. If you need to change the time, reply to this email.',
  }),

  callback_received: ({ payload }) => ({
    heading: 'We have your callback request',
    intro: 'A specialist will be in touch.',
    rows: [['Reference', field(payload, 'ticketNumber') ?? '—']],
  }),

  enquiry_received: ({ payload }) => ({
    heading: 'We have your enquiry',
    intro: 'A specialist will reply to you directly.',
    rows: [['Reference', field(payload, 'ticketNumber') ?? '—']],
  }),

  trade_in_received: ({ payload }) => ({
    heading: 'We have your trade-in details',
    intro: 'A specialist will arrange an appraisal.',
    rows: [['Reference', field(payload, 'ticketNumber') ?? '—']],
    // Stated in the email as well as in the conversation, so the customer is
    // never left expecting a number that is not coming (spec §41).
    closing: 'A trade-in value requires an in-person inspection, so we have not estimated one here.',
  }),

  financing_received: ({ payload }) => ({
    heading: 'We have your financing enquiry',
    intro: 'A specialist will confirm what is available to you.',
    rows: [['Reference', field(payload, 'ticketNumber') ?? '—']],
    closing:
      'Any figures discussed are estimates. They are not an offer of credit and not a guarantee of approval.',
  }),
};

export function renderTemplate(
  templateKey: string,
  subject: string,
  ctx: TemplateContext,
): RenderedTemplate {
  const template = TEMPLATES[templateKey];
  if (!template) {
    // An unknown template is a bug, but the customer still gets their
    // reference rather than nothing at all.
    return {
      subject,
      text: `${subject}\n\nReference: ${field(ctx.payload, 'ticketNumber') ?? '—'}`,
      html: `<p>${escapeHtml(subject)}</p>`,
    };
  }

  const { heading, intro, rows, closing } = template(ctx);
  const greeting = ctx.customerName ? `Hello ${ctx.customerName},` : 'Hello,';

  // A reference number the customer cannot look up is just a string. The link
  // is single-use and expiring, so it is safe to put in an email.
  const accessToken = field(ctx.payload, 'accessToken');
  const link = accessToken && ctx.baseUrl ? `${ctx.baseUrl}/r/${accessToken}` : null;

  const text = [
    greeting,
    '',
    heading,
    intro,
    '',
    ...rows.map(([label, value]) => `${label}: ${value}`),
    ...(link ? ['', `View your request: ${link}`] : []),
    ...(closing ? ['', closing] : []),
    '',
    ctx.brandName,
  ].join('\n');

  const html = `
<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;color:#131519;max-width:34rem">
  <p style="font-size:11px;letter-spacing:.25em;text-transform:uppercase;color:#6b7280;margin:0 0 24px">
    ${escapeHtml(ctx.brandName)}
  </p>
  <p style="margin:0 0 4px">${escapeHtml(greeting)}</p>
  <h1 style="font-size:20px;font-weight:500;margin:16px 0 8px">${escapeHtml(heading)}</h1>
  <p style="color:#6b7280;margin:0 0 24px">${escapeHtml(intro)}</p>
  <table style="border-collapse:collapse;width:100%;font-size:14px">
    ${rows
      .map(
        ([label, value]) => `<tr>
      <td style="padding:8px 0;color:#6b7280;border-bottom:1px solid #ebecef">${escapeHtml(label)}</td>
      <td style="padding:8px 0;text-align:right;border-bottom:1px solid #ebecef">${escapeHtml(value)}</td>
    </tr>`,
      )
      .join('')}
  </table>
  ${link ? `<p style="margin:24px 0 0"><a href="${escapeHtml(link)}" style="color:#131519">View your request</a></p>` : ''}
  ${closing ? `<p style="color:#6b7280;font-size:13px;margin:24px 0 0">${escapeHtml(closing)}</p>` : ''}
</div>`.trim();

  return { subject, text, html };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export const TEMPLATE_KEYS = Object.keys(TEMPLATES);
