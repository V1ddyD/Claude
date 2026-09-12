import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { env, features } from '@/server/config/env';
import { ruleBasedClient } from '@/server/ai/rule-based';
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
  /**
   * Same as converse, but text is handed over as it arrives.
   *
   * The tool loop still needs the COMPLETE message to dispatch a tool, so this
   * returns the same ModelTurn — streaming is an addition to the loop, not a
   * different shape of it. Deltas from a turn that ends in a tool call are the
   * model's preamble ("let me check that"), which is worth showing.
   */
  stream(request: ModelRequest, onDelta: (text: string) => void): Promise<ModelTurn>;
}

class AnthropicModelClient implements ModelClient {
  private readonly client: Anthropic;

  constructor(apiKey?: string) {
    // Passing no apiKey lets the SDK resolve credentials itself:
    // ANTHROPIC_API_KEY, then ANTHROPIC_AUTH_TOKEN, then an `ant auth login`
    // profile on disk. An operator who has signed in with the CLI should not
    // also have to paste a key into .env.local.
    this.client = new Anthropic({
      ...(apiKey ? { apiKey } : {}),
      maxRetries: 2,
      timeout: 60_000,
    });
  }

  async converse(request: ModelRequest): Promise<ModelTurn> {
    const response = await this.client.messages.create(this.params(request));
    return this.toTurn(response);
  }

  async stream(request: ModelRequest, onDelta: (text: string) => void): Promise<ModelTurn> {
    const stream = this.client.messages.stream(this.params(request));
    // The `text` event yields the delta string directly; filtering raw
    // content_block_delta events by hand would be the same thing, badly.
    stream.on('text', onDelta);
    return this.toTurn(await stream.finalMessage());
  }

  private params(request: ModelRequest): Anthropic.MessageCreateParamsNonStreaming {
    return {
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
    };
  }

  private toTurn(response: Anthropic.Message): ModelTurn {
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
 * The assistant a conversation should use.
 *
 * Chosen by AI_PROVIDER (spec §31): 'anthropic' for the model, 'scripted' for
 * the rule-based assistant, 'auto' for whichever the configuration supports.
 *
 * The scripted assistant drives the same tools against the same live data, so
 * the site works out of the box and the whole workflow — booking, ticketing,
 * scoring, email — can be exercised before a key exists. It is plainer, never
 * wrong, and it says so when it does not know something.
 *
 * Callers can still pass an explicit null to force the contact-form path
 * (spec §33 — every external dependency can fail).
 */
export function modelClient(): ModelClient {
  // The test seam wins, so a client injected in development or in a test is
  // still used whatever the configuration says.
  if (cached) return cached;
  if (features.aiProvider === 'scripted') return ruleBasedClient();
  cached = new AnthropicModelClient(env.ANTHROPIC_API_KEY);
  return cached;
}

/** True when SOME credential is present — a key, a token, or a CLI profile. */
export function hasCredential(): boolean {
  return features.ai;
}

/** Test seam. Also used to force degraded mode in development. */
export function setModelClient(client: ModelClient | null): void {
  cached = client ?? undefined;
}
