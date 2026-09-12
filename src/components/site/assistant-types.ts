export interface Receipt {
  ticketNumber: string;
  action: string;
  vehicle?: string;
  when?: string;
  confirmationCode?: string;
  confirmationEmail?: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  receipt?: Receipt;
  /** A failed send stays visible so the customer can retry it. */
  failed?: boolean;
  /** Still arriving. The caret shows only while this is true. */
  streaming?: boolean;
}

/**
 * Which assistant answered.
 *
 * 'scripted' is the rule-based assistant — real tools and real data, a fixed
 * set of instructions. 'offline' means none answered and the enquiry goes to
 * the team.
 */
export type AssistantMode = 'model' | 'scripted' | 'offline';

export interface ChatResponse {
  message: string;
  conversationId: string;
  degraded: boolean;
  mode?: AssistantMode;
  receipt?: Receipt;
}
