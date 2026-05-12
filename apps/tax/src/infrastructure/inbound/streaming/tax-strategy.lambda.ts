// Function URL Lambda: SSE-streams a Bedrock tool_use agent for fixed tax-strategy scenarios. No free-text input.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  closeSseStream,
  runAgent,
  verifyJwt,
  writeSseEvent,
  type Tool,
} from '@ym/agent-core';
import { BedrockKbClient } from '@ym/tax-domain';
import { ValidationError, toHttpErrorResponse, AppError } from '@ym/shared-errors';
import { getPool } from '../../outbound/pg/pg-pool.client.js';
import { buildSearchTaxLawTool } from '../../../application/tools/search-tax-law.tool.js';
import { buildGetFilingDraftTool } from '../../../application/tools/get-filing-draft-detail.tool.js';
import {
  TAX_SCENARIOS,
  buildContext,
  buildUserMessage,
  getSystemPrompt,
  isTaxScenario,
} from '../../../application/strategy-templates.js';

const RequestBodySchema = z
  .object({
    tenantId: z.string().uuid(),
    scenario: z.enum(TAX_SCENARIOS),
  })
  .strict();

interface ResponseStream {
  write(chunk: string): boolean;
  end(cb?: () => void): void;
  setContentType?(type: string): void;
}

interface FunctionUrlEvent {
  rawPath?: string;
  body?: string;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
}

const SCENARIO_PATH_PARAM_RE = /^\/tenants\/([0-9a-f-]+)\/tax\/strategy\/?$/i;

const decodeBody = (event: FunctionUrlEvent): string => {
  if (!event.body) return '';
  if (event.isBase64Encoded) return Buffer.from(event.body, 'base64').toString('utf-8');
  return event.body;
};

const handlerImpl = async (event: FunctionUrlEvent, responseStream: ResponseStream): Promise<void> => {
  const runId = randomUUID();
  const startedAt = Date.now();
  let toolCalls = 0;

  try {
    responseStream.setContentType?.('text/event-stream');

    const claims = await verifyJwt(event.headers?.authorization ?? event.headers?.Authorization);

    const bodyText = decodeBody(event);
    let body: unknown = {};
    if (bodyText) {
      try { body = JSON.parse(bodyText); }
      catch { throw new ValidationError('Request body is not valid JSON'); }
    }

    const parsed = RequestBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new ValidationError(`Invalid request: ${parsed.error.issues.map((i) => i.message).join(', ')}`);
    }

    const pathMatch = SCENARIO_PATH_PARAM_RE.exec(event.rawPath ?? '');
    if (pathMatch && pathMatch[1] && pathMatch[1].toLowerCase() !== parsed.data.tenantId.toLowerCase()) {
      throw new ValidationError('tenantId mismatch between path and body');
    }
    if (!isTaxScenario(parsed.data.scenario)) {
      throw new ValidationError(`Unknown scenario: ${parsed.data.scenario}`);
    }

    const tenantId = parsed.data.tenantId;
    const ctx = { tenantId, userId: claims.cognitoSub, cognitoSub: claims.cognitoSub };

    writeSseEvent(responseStream, { type: 'started', runId, scenario: parsed.data.scenario });

    const agentContext = await buildContext({
      pool: getPool(),
      tenantId,
      cognitoSub: claims.cognitoSub,
      scenario: parsed.data.scenario,
    });
    writeSseEvent(responseStream, { type: 'context_ready', keys: agentContext.contextKeys });

    const kbClient = new BedrockKbClient();
    const tools: Tool[] = [
      buildSearchTaxLawTool(kbClient) as Tool,
      buildGetFilingDraftTool(getPool()) as Tool,
    ];

    const heartbeat = setInterval(() => {
      // Real data line — Function URL counts comments differently in the 30s no-activity window.
      responseStream.write(`data: {"type":"heartbeat","ts":${Date.now()}}\n\n`);
    }, 10_000);
    let result;
    try {
      result = await runAgent({
        systemPrompt: getSystemPrompt(),
        userMessage: buildUserMessage(parsed.data.scenario, agentContext),
        tools,
        ctx,
        onEvent: (e) => writeSseEvent(responseStream, e),
        maxIterations: 8,
        maxTokens: 4096,
      });
    } finally {
      clearInterval(heartbeat);
    }
    toolCalls = result.toolCalls;

    writeSseEvent(responseStream, {
      type: 'final',
      summary: result.finalText.slice(0, 500),
      metadata: { tokens: { input: result.inputTokens, output: result.outputTokens } },
    });
    writeSseEvent(responseStream, {
      type: 'done',
      durationMs: Date.now() - startedAt,
      toolCalls,
      tokens: { input: result.inputTokens, output: result.outputTokens },
    });
  } catch (err) {
    const message = err instanceof AppError ? err.userMessage : err instanceof Error ? err.message : 'internal error';
    const recoverable = err instanceof AppError ? err.statusCode < 500 : false;
    writeSseEvent(responseStream, { type: 'error', reason: message, recoverable });
    writeSseEvent(responseStream, { type: 'done', durationMs: Date.now() - startedAt, toolCalls });
    if (!(err instanceof AppError)) {
      const mapped = toHttpErrorResponse(err, { path: event.rawPath ?? '/tax/strategy' });
      // eslint-disable-next-line no-console
      console.error('tax-strategy unhandled', mapped);
    }
  } finally {
    await closeSseStream(responseStream);
  }
};

interface AwsLambdaStreamingGlobal {
  streamifyResponse(
    fn: (event: FunctionUrlEvent, responseStream: ResponseStream) => Promise<void>,
  ): (event: FunctionUrlEvent, responseStream: ResponseStream) => Promise<void>;
}

const streamify = (globalThis as unknown as { awslambda?: AwsLambdaStreamingGlobal }).awslambda?.streamifyResponse;

export const handler = streamify ? streamify(handlerImpl) : handlerImpl;
