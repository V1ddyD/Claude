/**
 * Follow-up rules (spec §14).
 *
 * These create a task for a PERSON. They never message the customer.
 *
 * That is a deliberate line: automated outbound on a dealership's behalf is a
 * reputational and legal exposure that belongs to a human decision, and spec
 * §14 is explicit that the system should not spam customers. What the system
 * is good at is noticing — so it notices, and tells staff what to do about it.
 */

export interface FollowUpRule {
  key: string;
  description: string;
  /** Shown to staff as the action to take. */
  recommendedAction: string;
  delayMinutes: number;
  /** Whether the delay should only count during opening hours. */
  businessHoursOnly: boolean;
}

export const DEFAULT_FOLLOW_UP_RULES: FollowUpRule[] = [
  {
    key: 'high_priority_untouched',
    description: 'High-priority lead with no contact from the team',
    recommendedAction: 'Call — high priority and nobody has spoken to them yet',
    delayMinutes: 120,
    businessHoursOnly: true,
  },
  {
    key: 'callback_requested',
    description: 'Customer asked to be called back',
    recommendedAction: 'Call them back — they asked us to',
    delayMinutes: 60,
    businessHoursOnly: true,
  },
  {
    key: 'handoff_requested',
    description: 'Customer asked to speak to a person',
    recommendedAction: 'Take over the conversation — they asked for a person',
    delayMinutes: 30,
    businessHoursOnly: true,
  },
  {
    key: 'test_drive_tomorrow',
    description: 'Test drive booked for tomorrow',
    recommendedAction: 'Confirm tomorrow’s test drive and have the car ready',
    delayMinutes: 0,
    businessHoursOnly: false,
  },
  {
    key: 'lead_dormant',
    description: 'No activity on an open lead for a week',
    recommendedAction: 'Re-engage, or move to Nurture if they have gone quiet',
    delayMinutes: 7 * 24 * 60,
    businessHoursOnly: false,
  },
];
