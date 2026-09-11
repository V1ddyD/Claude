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
}

export interface ChatResponse {
  message: string;
  conversationId: string;
  degraded: boolean;
  receipt?: Receipt;
}
