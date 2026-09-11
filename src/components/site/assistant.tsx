'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ConfirmationSlip } from './confirmation-slip';
import type { ChatMessage, ChatResponse } from './assistant-types';

/**
 * The Sinclair assistant.
 *
 * Part of the dealership experience rather than a widget bolted over it
 * (spec §35, §37): it sits in the page's own visual language, opens as a panel
 * rather than a bubble, and never advertises itself as AI.
 *
 * This is a presentation component. It holds no business logic: the tenant, the
 * visitor and the conversation all live server-side, and this only sends text
 * and renders what comes back.
 */

interface AssistantProps {
  brandName: string;
  /** One line, in the dealership's voice. Not a capability list. */
  greeting: string;
  suggestions?: string[];
}

export function Assistant({ brandName, greeting, suggestions = [] }: AssistantProps) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [pending, setPending] = useState(false);
  const [conversationId, setConversationId] = useState<string | undefined>();

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, pending]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  // Escape closes the panel — expected of anything that covers the page.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || pending) return;

      const outgoing: ChatMessage = { id: crypto.randomUUID(), role: 'user', text: trimmed };
      setMessages((current) => [...current, outgoing]);
      setInput('');
      setPending(true);

      try {
        const response = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: trimmed, conversationId }),
        });

        if (!response.ok) {
          const problem = (await response.json().catch(() => null)) as { message?: string } | null;
          throw new Error(problem?.message ?? 'Something went wrong.');
        }

        const data = (await response.json()) as ChatResponse;
        setConversationId(data.conversationId);
        setMessages((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            text: data.message,
            ...(data.receipt ? { receipt: data.receipt } : {}),
          },
        ]);
      } catch (error) {
        // The customer is told plainly, and their message stays on screen so
        // they can send it again rather than retyping it.
        setMessages((current) => [
          ...current,
          {
            id: crypto.randomUUID(),
            role: 'assistant',
            text:
              error instanceof Error
                ? error.message
                : "I couldn't send that just now. Please try again.",
            failed: true,
          },
        ]);
      } finally {
        setPending(false);
      }
    },
    [conversationId, pending],
  );

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls="sinclair-assistant"
        className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full bg-ink-900 px-5 py-3 text-sm text-white shadow-lg transition-colors hover:bg-ink-800 sm:bottom-8 sm:right-8"
      >
        {open ? 'Close' : `Ask ${brandName}`}
      </button>

      <div
        id="sinclair-assistant"
        hidden={!open}
        role="dialog"
        aria-label={`${brandName} assistant`}
        className="fixed inset-x-0 bottom-0 z-30 flex h-[min(38rem,85vh)] flex-col border-t border-ink-100 bg-ink-50 shadow-2xl sm:inset-x-auto sm:bottom-24 sm:right-8 sm:h-[min(34rem,75vh)] sm:w-[26rem] sm:rounded sm:border"
      >
        <header className="border-b border-ink-100 bg-white px-5 py-4">
          <p className="text-[10px] uppercase tracking-[0.25em] text-ink-500">{brandName}</p>
          <p className="mt-0.5 text-sm text-ink-900">Product specialist</p>
        </header>

        <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-5 py-4">
          {messages.length === 0 && (
            <>
              <p className="leading-relaxed text-ink-500">{greeting}</p>
              {suggestions.length > 0 && (
                <div className="flex flex-wrap gap-2 pt-2">
                  {suggestions.map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => send(suggestion)}
                      className="rounded-full border border-ink-100 bg-white px-3 py-1.5 text-left text-[13px] text-ink-900 transition-colors hover:border-ink-300"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          {messages.map((message) => (
            <div key={message.id}>
              <div
                className={
                  message.role === 'user'
                    ? 'ml-auto w-fit max-w-[85%] rounded bg-ink-900 px-3.5 py-2.5 text-white'
                    : `w-fit max-w-[92%] rounded px-3.5 py-2.5 ${
                        message.failed ? 'bg-accent-600/10 text-accent-600' : 'bg-white text-ink-900'
                      }`
                }
              >
                <p className="whitespace-pre-wrap text-[15px] leading-relaxed">{message.text}</p>
              </div>
              {message.receipt && (
                <ConfirmationSlip receipt={message.receipt} brandName={brandName} />
              )}
            </div>
          ))}

          {/* Announced to assistive technology without stealing focus. */}
          <div aria-live="polite" className="sr-only">
            {pending ? 'Thinking' : messages.at(-1)?.role === 'assistant' ? messages.at(-1)!.text : ''}
          </div>

          {pending && (
            <div className="w-fit rounded bg-white px-3.5 py-3">
              <span className="flex gap-1" aria-hidden>
                {[0, 150, 300].map((delay) => (
                  <span
                    key={delay}
                    className="h-1.5 w-1.5 animate-pulse rounded-full bg-ink-300"
                    style={{ animationDelay: `${delay}ms` }}
                  />
                ))}
              </span>
            </div>
          )}
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void send(input);
          }}
          className="border-t border-ink-100 bg-white px-4 py-3"
        >
          <div className="flex items-end gap-2">
            <label htmlFor="assistant-input" className="sr-only">
              Message
            </label>
            <textarea
              id="assistant-input"
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                // Enter sends; Shift+Enter is a newline, as people expect.
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  void send(input);
                }
              }}
              rows={1}
              maxLength={2000}
              placeholder="Ask about a model, a price, or book a test drive"
              className="max-h-28 flex-1 resize-none bg-transparent text-[15px] leading-relaxed text-ink-900 placeholder:text-ink-300 focus:outline-none"
            />
            <button
              type="submit"
              disabled={pending || input.trim().length === 0}
              className="shrink-0 rounded bg-ink-900 px-3.5 py-2 text-sm text-white transition-colors hover:bg-ink-800 disabled:bg-ink-100 disabled:text-ink-300"
            >
              Send
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
