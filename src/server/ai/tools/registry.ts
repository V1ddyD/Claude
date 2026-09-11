import 'server-only';
import { ZodObject } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { and, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { toolInvocations } from '@/server/db/schema';
import { AppError, isAppError, toPublicError } from '@/server/errors';
import {
  FORBIDDEN_INPUT_FIELDS, FORBIDDEN_QUERY_FIELDS,
  type ToolContext, type ToolDefinition,
} from './define';

export type { ToolDefinition };

/**
 * The tool registry.
 *
 * Every action the assistant can take is here and nowhere else. The four
 * invariants in docs/03-ai-tools.md are checked when the registry is built, so
 * a tool that violates one is a startup failure — not something a reviewer has
 * to notice.
 */

/**
 * Any concrete tool, with its generics erased so differently-typed tools can
 * live in one registry. The types are enforced where each tool is DEFINED, by
 * defineTool; this alias only exists to store them together.
 */
export type AnyTool = ToolDefinition<any, any>;

export interface RegisteredTool {
  definition: AnyTool;
  /** The shape sent to the model. */
  schema: { name: string; description: string; input_schema: Record<string, unknown> };
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  constructor(definitions: AnyTool[]) {
    for (const definition of definitions) {
      assertValid(definition);

      const jsonSchema = zodToJsonSchema(definition.input, {
        target: 'jsonSchema7',
        $refStrategy: 'none',
      }) as Record<string, unknown>;

      this.tools.set(definition.name, {
        definition,
        schema: {
          name: definition.name,
          description: definition.summary,
          input_schema: jsonSchema,
        },
      });
    }
  }

  list(): RegisteredTool[] {
    return [...this.tools.values()];
  }

  /** The tool list in the shape the model API expects. */
  schemas() {
    return this.list().map((t) => t.schema);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  /**
   * Run a tool the model asked for.
   *
   * Returns a projected, customer-safe result, or a typed error the assistant
   * can relay. Never throws at the caller: a tool failure is something the
   * conversation handles, not something that takes the request down.
   */
  async dispatch(
    ctx: ToolContext,
    name: string,
    rawInput: unknown,
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: ReturnType<typeof toPublicError> }> {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, error: toPublicError(new AppError('NOT_FOUND', `Unknown tool: ${name}`)) };
    }

    const parsed = tool.definition.input.safeParse(rawInput ?? {});
    if (!parsed.success) {
      // Schema-validated inputs are also what stops injected text becoming a
      // new parameter: anything not in the schema is dropped here.
      return {
        ok: false,
        error: toPublicError(
          new AppError('VALIDATION_FAILED', 'That request was not understood.', {
            internal: parsed.error.issues,
          }),
        ),
      };
    }

    const started = Date.now();
    const idempotencyKey =
      tool.definition.scope === 'write'
        ? buildKey(ctx, name, tool.definition.idempotent!(parsed.data, ctx))
        : undefined;

    if (idempotencyKey) {
      const replay = await this.findPreviousInvocation(ctx, idempotencyKey);
      // A retry returns the first result. Spec §33: retrying a booking must
      // never produce a second appointment.
      if (replay) return { ok: true, result: replay };
    }

    try {
      // Each tool runs inside a SAVEPOINT.
      //
      // The conversation shares one transaction, and a tool failure is caught
      // here rather than thrown — so without this, a write tool that fails
      // halfway leaves its earlier inserts committed. That is exactly the
      // partial record spec §33 forbids: a lead and a ticket with no
      // appointment behind them. Rolling back to the savepoint leaves nothing.
      const projected = await ctx.db.transaction(async (savepoint) => {
        const scoped = Object.assign(savepoint, { tenantId: ctx.tenantId });
        const output = await tool.definition.handler(
          { ...ctx, db: scoped as typeof ctx.db },
          parsed.data,
        );
        return tool.definition.project(output, ctx);
      });

      if (idempotencyKey) {
        await ctx.db.insert(toolInvocations).values({
          tenantId: ctx.tenantId,
          conversationId: ctx.conversationId,
          toolName: name,
          idempotencyKey,
          status: 'succeeded',
          result: projected as never,
          durationMs: Date.now() - started,
        });
      }

      return { ok: true, result: projected };
    } catch (err) {
      // Recorded outside the rolled-back savepoint, so the failure itself is
      // still on the record even though its writes are not.
      if (idempotencyKey && isAppError(err)) {
        await ctx.db.insert(toolInvocations).values({
          tenantId: ctx.tenantId,
          conversationId: ctx.conversationId,
          toolName: name,
          idempotencyKey,
          status: 'failed',
          errorCode: err.code,
          durationMs: Date.now() - started,
        });
      }
      // Unexpected errors are reduced to a generic message here; the detail
      // stays in the AppError's `internal` and never reaches the model.
      return { ok: false, error: toPublicError(err) };
    }
  }

  private async findPreviousInvocation(ctx: ToolContext, key: string): Promise<unknown | null> {
    const rows = await ctx.db
      .select({ status: toolInvocations.status, result: toolInvocations.result })
      .from(toolInvocations)
      .where(
        and(eq(toolInvocations.tenantId, ctx.tenantId), eq(toolInvocations.idempotencyKey, key)),
      )
      .limit(1);

    const previous = rows[0];
    // Only a success is replayed. A previous failure is retried, because the
    // cause may have been transient.
    return previous?.status === 'succeeded' ? previous.result : null;
  }
}

function buildKey(ctx: ToolContext, toolName: string, discriminator: string): string {
  return createHash('sha256')
    .update([ctx.conversationId, toolName, discriminator].join('|'))
    .digest('hex')
    .slice(0, 48);
}

function assertValid(definition: AnyTool): void {
  const where = `Tool "${definition.name}"`;

  if (typeof definition.project !== 'function') {
    throw new Error(`${where} must define project(): no result may reach the model unprojected.`);
  }

  if (definition.scope === 'write' && typeof definition.idempotent !== 'function') {
    throw new Error(
      `${where} is a write tool and must define idempotent(): without it a retried ` +
        'call creates a duplicate record.',
    );
  }

  const shape = definition.input instanceof ZodObject ? Object.keys(definition.input.shape) : [];

  for (const field of shape) {
    if (FORBIDDEN_INPUT_FIELDS.some((f) => f.toLowerCase() === field.toLowerCase())) {
      throw new Error(
        `${where} declares "${field}" as an input. Identity comes from the server-side ` +
          'session, never from the model — a tenant or customer the model can name is a ' +
          'tenant or customer it can reach.',
      );
    }
    // Both sides lowercased: the list holds `orderBy`, and comparing a
    // lowercased field against it let `orderBy` through unnoticed.
    if (FORBIDDEN_QUERY_FIELDS.some((f) => f.toLowerCase() === field.toLowerCase())) {
      throw new Error(
        `${where} declares "${field}" as an input. Tools are fixed questions with typed ` +
          'parameters; a filter, table or ordering parameter is a query surface.',
      );
    }
  }
}
