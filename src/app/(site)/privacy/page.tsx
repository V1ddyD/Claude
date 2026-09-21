import { headers } from 'next/headers';
import { resolveTenantByHost } from '@/server/context/tenant';
import { features } from '@/server/config/env';

/**
 * The privacy policy.
 *
 * Written against what the system actually does, not from a template. Every
 * claim here is checkable in the code: the retention period is
 * `DEFAULT_RETENTION_MONTHS`, "each dealership sees only its own" is the RLS
 * policy in migration 0002, and "we never see your Instagram password" is a
 * property of OAuth rather than a promise.
 *
 * It exists because Meta requires one before an app may be published, but a
 * policy written to satisfy a form and a policy that is true should be the
 * same document. If the system changes, this changes.
 */
export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'Privacy',
  description: 'What the assistant records, why, and how to have it removed.',
};

export default async function PrivacyPage() {
  const tenant = await resolveTenantByHost((await headers()).get('host'));

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <h1 className="text-3xl font-medium tracking-tight text-ink-900">Privacy</h1>
      <p className="mt-3 text-sm text-ink-500">
        How {tenant.brandName} handles what you tell its assistant.
      </p>

      {features.demoPortal && (
        <p className="mt-8 rounded-lg border border-ink-100 bg-ink-50 px-4 py-3 text-sm text-ink-700">
          This is a demonstration site. {tenant.brandName} is a fictional dealership, and
          nothing booked here is a real appointment. The policy below still describes
          exactly what the software does with what you type, because it is the same
          software a real business would use.
        </p>
      )}

      <Section title="What is recorded">
        <p>
          <strong>What you write.</strong> Messages you send to the assistant are stored,
          whether you send them on this website or as an Instagram direct message. So are
          the assistant&rsquo;s replies, and a note of which information it looked up to
          answer you.
        </p>
        <p>
          <strong>Details you choose to give.</strong> A name, an email address or a phone
          number are recorded only when you type them — usually because you asked to book
          something or to be contacted. You are never required to give them to ask a
          question.
        </p>
        <p>
          <strong>Who you are on the platform you wrote from.</strong> On Instagram, that
          is the account identifier and display name Instagram gives us. We never see your
          password, your followers, your posts or anything else on your account.
        </p>
        <p>
          <strong>A cookie, on the website only.</strong> One cookie links your messages
          into a single conversation so the assistant does not forget what you said a
          moment ago. It holds a random identifier and nothing about you.
        </p>
      </Section>

      <Section title="What it is used for">
        <p>
          Answering your question, using {tenant.brandName}&rsquo;s own information about
          its vehicles, prices, stock and diary — and passing your enquiry to a person here
          so somebody can follow it up.
        </p>
        <p>
          Staff can read the conversation you had. That is the point of it: it saves you
          repeating yourself to the person who calls you back.
        </p>
      </Section>

      <Section title="What is not done with it">
        <p>
          It is not sold, and it is not shared with other businesses for their own
          purposes.
        </p>
        <p>
          Where this software serves more than one business, each one can see only its own
          conversations. That separation is enforced by the database itself rather than by
          the application asking nicely — a business cannot read another&rsquo;s enquiries
          even if the software is at fault.
        </p>
      </Section>

      <Section title="How long it is kept">
        <p>
          The contents of a conversation are removed two years after its last message. What
          remains is the record that an enquiry happened — the appointment, the ticket, the
          fact somebody asked about a particular car — without the words.
        </p>
        <p>
          A business needs to know it sold someone a car. It does not need the transcript
          two years later.
        </p>
      </Section>

      <Section title="Having it removed sooner">
        <p>
          Ask, and it will be deleted. Message the {tenant.brandName} account you spoke to
          on Instagram, or say so in the assistant and ask to be passed to a person.
        </p>
        <p>
          Tell us roughly when you got in touch and what you asked about, so the right
          conversation is found. Removing your details also removes the assistant&rsquo;s
          memory of them, so a future conversation starts fresh.
        </p>
      </Section>

      <Section title="Talking to a person instead">
        <p>
          You never have to use the assistant. Ask for a person at any point and the
          conversation is passed to staff, who will reply themselves.
        </p>
      </Section>

      <p className="mt-12 border-t border-ink-100 pt-6 text-xs text-ink-500">
        {tenant.legalName}. This page describes the current behaviour of the software and
        is updated when that behaviour changes.
      </p>
    </main>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-10">
      <h2 className="text-sm font-medium uppercase tracking-[0.14em] text-ink-900">
        {title}
      </h2>
      <div className="mt-3 space-y-3 text-sm leading-relaxed text-ink-700">{children}</div>
    </section>
  );
}
