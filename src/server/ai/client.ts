import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { env, features } from '@/server/config/env';
import { AppError } from '@/server/errors';

/**
 * The ONLY module that reads ANTHROPIC_API_KEY.
 *
 * Enforced by an ESLint restricted-import rule and by a CI grep of the built
 * client bundle. The key must never reach the browser (spec §32).
 *
 * The model sits behind a narrow interface so the conversation loop, the
 * extraction pass and every test can run against a scripted client. That is not
 * only for testing: it is what lets the assistant degrade to a contact form
 * when the model is unavailable rather than taking the site down.
 */

/** Claude Opus 5. Adaptive thinking; `budget_tokens` is rejected on this model. */
export const CONVERSATION_MODEL = 'claude-opus-5';
export const EXTRACTION_MODEL = 'claude-opus-5';

export interface ModelToolUse {
  id: string;
  name: string;
  input: unknown;
}

export interface ModelTurn {
  text: string;
  toolUses: ModelToolUse[];
  stopReason: string | null;
  usage: { inputTokens: number; outputTokens: number };
}

export interface ModelRequest {
  system: string;
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
  maxTokens?: number;
  /** Latency matters in chat; depth matters in extraction. */
  effort?: 'low' | 'medium' | 'high';
  model?: string;
}

export interface ModelClient {
  converse(request: ModelRequest): Promise<ModelTurn>;
}

class AnthropicModelClient implements ModelClient {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 60_000 });
  }

  async converse(request: ModelRequest): Promise<ModelTurn> {
    const response = await this.client.messages.create({
      model: request.model ?? CONVERSATION_MODEL,
      max_tokens: request.maxTokens ?? 4096,
      // The system prompt and tool list are the stable prefix. Marking the
      // system block cacheable is what keeps per-turn cost down across a long
      // conversation; anything volatile must come after it.
      system: [
        { type: 'text', text: request.system, cache_control: { type: 'ephemeral' } },
      ],
      ...(request.tools ? { tools: request.tools } : {}),
      output_config: { effort: request.effort ?? 'low' },
      messages: request.messages,
    });

    // A safety decline is a normal outcome, not an exception: check before
    // reading content, which is empty in that case.
    if (response.stop_reason === 'refusal') {
      throw new AppError('DEPENDENCY_UNAVAILABLE', 'I cannot help with that request.', {
        internal: { stopDetails: response.stop_details },
      });
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    const toolUses = response.content
      .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
      .map((block) => ({ id: block.id, name: block.name, input: block.input }));

    return {
      text,
      toolUses,
      stopReason: response.stop_reason,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}

let cached: ModelClient | undefined;

/**
 * Returns null when no key is configured. Callers degrade rather than throw:
 * the catalogue stays browsable and enquiries still reach the dealership
 * through a form (spec §33 — every external dependency can fail).
 */
export function modelClient(): ModelClient | null {
  if (!features.ai) return null;
  cached ??= new AnthropicModelClient(env.ANTHROPIC_API_KEY!);
  return cached;
}

/** Test seam. Also used to force degraded mode in development. */
export function setModelClient(client: ModelClient | null): void {
  cached = client ?? undefined;
}
