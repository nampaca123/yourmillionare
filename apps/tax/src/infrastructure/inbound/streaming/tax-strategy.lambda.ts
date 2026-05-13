// Function URL Lambda: SSE-streams a Bedrock tool_use agent for fixed tax-strategy scenarios. No free-text input.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  runAgent,
  withStreamingErrorBoundary,
  writeSseEvent,
  type StreamingFunctionUrlEvent,
  type StreamingResponseStream,
  type Tool,
} from '@ym/agent-core';
import { verifyJwt } from '@ym/shared-auth';
import { BedrockKbClient } from '@ym/tax-domain';
import { ValidationError } from '@ym/shared-errors';
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

type ResponseStream = StreamingResponseStream;
type FunctionUrlEvent = StreamingFunctionUrlEvent;

const SCENARIO_PATH_PARAM_RE = /^\/tenants\/([0-9a-f-]+)\/tax\/strategy\/?$/i;

const decodeBody = (event: FunctionUrlEvent): string => {
  if (!event.body) return '';
  if (event.isBase64Encoded) return Buffer.from(event.body, 'base64').toString('utf-8');
  return event.body;
};

const HEARTBEAT_INTERVAL_MS = 10_000;
const FINAL_TEXT_MAX_LENGTH = 500;
const MAX_AGENT_ITERATIONS = 8;
const MAX_AGENT_TOKENS = 4096;

const handlerImpl = async (event: FunctionUrlEvent, responseStream: ResponseStream): Promise<void> => {
  const runId = randomUUID();
  const startedAt = Date.now();

  responseStream.setContentType?.('text/event-stream');

  const claims = await verifyJwt(event.headers?.authorization ?? event.headers?.Authorization);

  const bodyText = decodeBody(event);
  let body: unknown = {};
  if (bodyText) {
    try {
      body = JSON.parse(bodyText);
    } catch {
      throw new ValidationError('Request body is not valid JSON');
    }
  }

  const parsed = RequestBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new ValidationError(
      `Invalid request: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
    );
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
    responseStream.write(`data: {"type":"heartbeat","ts":${Date.now()}}\n\n`);
  }, HEARTBEAT_INTERVAL_MS);
  let result;
  try {
    result = await runAgent({
      systemPrompt: getSystemPrompt(),
      userMessage: buildUserMessage(parsed.data.scenario, agentContext),
      tools,
      ctx,
      onEvent: (e) => writeSseEvent(responseStream, e),
      maxIterations: MAX_AGENT_ITERATIONS,
      maxTokens: MAX_AGENT_TOKENS,
    });
  } finally {
    clearInterval(heartbeat);
  }

  writeSseEvent(responseStream, {
    type: 'final',
    summary: result.finalText.slice(0, FINAL_TEXT_MAX_LENGTH),
    metadata: { tokens: { input: result.inputTokens, output: result.outputTokens } },
  });
  writeSseEvent(responseStream, {
    type: 'done',
    durationMs: Date.now() - startedAt,
    toolCalls: result.toolCalls,
    tokens: { input: result.inputTokens, output: result.outputTokens },
  });
};

interface AwsLambdaStreamingGlobal {
  streamifyResponse(
    fn: (event: FunctionUrlEvent, responseStream: ResponseStream) => Promise<void>,
  ): (event: FunctionUrlEvent, responseStream: ResponseStream) => Promise<void>;
}

const guardedHandler = withStreamingErrorBoundary({ path: '/tax/strategy' }, handlerImpl);
const streamify = (globalThis as unknown as { awslambda?: AwsLambdaStreamingGlobal }).awslambda?.streamifyResponse;

export const handler = streamify ? streamify(guardedHandler) : guardedHandler;
