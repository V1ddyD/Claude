import type { ModelClient, ModelRequest, ModelTurn } from '../../src/server/ai/client';

/**
 * A model that does exactly what a test tells it to.
 *
 * The conversation spine — tool dispatch, idempotency, projection, persistence,
 * extraction, scoring — is all deterministic code. Scripting the model lets
 * every part of it be asserted without a network call, and makes the assertions
 * about OUR behaviour rather than about what a model happened to say.
 */

export interface ScriptedTurn {
  text?: string;
  toolUses?: { name: string; input: unknown }[];
}

export class ScriptedModel implements ModelClient {
  readonly requests: ModelRequest[] = [];
  private index = 0;

  constructor(private readonly script: ScriptedTurn[]) {}

  async converse(request: ModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    return this.take();
  }

  /**
   * Streams the scripted text word by word.
   *
   * Chunked rather than emitted whole so the streaming path is genuinely
   * exercised: a consumer that only works when the entire message arrives in
   * one delta is not a streaming consumer.
   */
  async stream(request: ModelRequest, onDelta: (text: string) => void): Promise<ModelTurn> {
    this.requests.push(request);
    const turn = this.take();

    for (const chunk of turn.text.match(/\S+\s*/g) ?? []) {
      onDelta(chunk);
    }
    return turn;
  }

  private take(): ModelTurn {
    const turn = this.script[this.index++] ?? { text: '' };

    return {
      text: turn.text ?? '',
      toolUses: (turn.toolUses ?? []).map((u, i) => ({
        id: `toolu_${this.index}_${i}`,
        name: u.name,
        input: u.input,
      })),
      stopReason: turn.toolUses?.length ? 'tool_use' : 'end_turn',
      usage: { inputTokens: 100, outputTokens: 50 },
    };
  }

  /** Everything the model was shown, for leakage assertions. */
  everythingSeen(): string {
    return this.requests
      .map((r) => r.system + JSON.stringify(r.messages))
      .join('\n');
  }
}
