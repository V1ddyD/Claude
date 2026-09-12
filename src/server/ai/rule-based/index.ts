import type { ModelClient, ModelRequest, ModelTurn } from '@/server/ai/client';
import { readConversation } from './state';
import { decide } from './script';

/**
 * A model-shaped assistant with no model behind it.
 *
 * It implements the same interface as the Anthropic client, so it drives the
 * same tools, the same services, the same lead scoring and the same portal.
 * Nothing downstream of this file knows the difference, which is the point:
 * the workflow can be exercised end to end before a key exists, and putting
 * the real model back is a change to one function in client.ts.
 *
 * It is honest about what it is. It never invents a figure — every number it
 * says came out of a tool — and when it does not recognise a question it says
 * so and offers the team.
 */
export class RuleBasedModel implements ModelClient {
  private turns = 0;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async converse(request: ModelRequest): Promise<ModelTurn> {
    return this.take(request);
  }

  async stream(request: ModelRequest, onDelta: (text: string) => void): Promise<ModelTurn> {
    const turn = this.take(request);
    // Word by word, so the interface has one code path whichever assistant is
    // running and a consumer cannot come to depend on whole-message delivery.
    for (const chunk of turn.text.match(/\S+\s*/g) ?? []) {
      onDelta(chunk);
    }
    return turn;
  }

  private take(request: ModelRequest): ModelTurn {
    const decision = decide(request.system, readConversation(request.messages), this.clock());
    const turn = this.turns++;

    return {
      text: decision.text,
      toolUses: decision.tools.map((tool, index) => ({
        id: `rule_${turn}_${index}`,
        name: tool.name,
        input: tool.input,
      })),
      stopReason: decision.tools.length > 0 ? 'tool_use' : 'end_turn',
      // No tokens were bought. Recording zero keeps the usage ledger truthful
      // rather than inventing a cost the dealership never incurred.
      usage: { inputTokens: 0, outputTokens: 0 },
    };
  }
}

let cached: RuleBasedModel | undefined;

export function ruleBasedClient(): RuleBasedModel {
  cached ??= new RuleBasedModel();
  return cached;
}

export { decide } from './script';
export { readConversation, remember } from './state';
