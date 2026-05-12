// Generic Bedrock Converse tool_use loop with per-step event emission for SSE streaming.

import {
  AccessDeniedException,
  ConverseCommand,
  ResourceNotFoundException,
  ServiceUnavailableException,
  ThrottlingException,
  type ContentBlock,
  type Message,
  type Tool as BedrockToolUnion,
} from '@aws-sdk/client-bedrock-runtime';
import { BedrockUnavailableError, RateLimitError } from '@ym/shared-errors';
import { getBedrockClient, DEFAULT_MODEL_ID } from './bedrock-client.js';
import type { AgentSseEvent } from './sse-event.types.js';
import type { Tool, ToolContext } from './tool.types.js';

export interface RunAgentInput {
  readonly systemPrompt: string;
  readonly userMessage: string;
  readonly tools: ReadonlyArray<Tool>;
  readonly ctx: ToolContext;
  readonly onEvent: (event: AgentSseEvent) => void;
  readonly maxIterations?: number;
  readonly maxTokens?: number;
  readonly modelId?: string;
}

export interface RunAgentResult {
  readonly finalText: string;
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

const DEFAULT_MAX_ITERATIONS = 8;
const DEFAULT_MAX_TOKENS = 4096;

const toBedrockTools = (tools: ReadonlyArray<Tool>): BedrockToolUnion[] =>
  tools.map(
    (t) =>
      ({
        toolSpec: {
          name: t.name,
          description: t.description,
          inputSchema: { json: t.inputSchema as unknown as Record<string, unknown> },
        },
      }) as BedrockToolUnion,
  );

const summarizeToolResult = (result: unknown): string => {
  if (typeof result === 'string') return result.slice(0, 200);
  if (result && typeof result === 'object') {
    const obj = result as Record<string, unknown>;
    if (typeof obj.summary === 'string') return obj.summary.slice(0, 200);
    if (Array.isArray(obj.items)) return `${obj.items.length} items`;
    return JSON.stringify(obj).slice(0, 200);
  }
  return String(result).slice(0, 200);
};

export const runAgent = async (input: RunAgentInput): Promise<RunAgentResult> => {
  const client = getBedrockClient();
  const modelId = input.modelId ?? DEFAULT_MODEL_ID;
  const maxIterations = input.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  const maxTokens = input.maxTokens ?? DEFAULT_MAX_TOKENS;

  const toolMap = new Map<string, Tool>(input.tools.map((t) => [t.name, t]));
  const bedrockTools = toBedrockTools(input.tools);

  const messages: Message[] = [{ role: 'user', content: [{ text: input.userMessage }] }];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let toolCalls = 0;
  let finalText = '';

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    let response;
    try {
      response = await client.send(
        new ConverseCommand({
          modelId,
          system: [{ text: input.systemPrompt }],
          messages,
          inferenceConfig: { maxTokens, temperature: 0.2 },
          toolConfig: bedrockTools.length > 0 ? { tools: bedrockTools } : undefined,
        }),
      );
    } catch (err) {
      if (
        err instanceof ResourceNotFoundException ||
        err instanceof AccessDeniedException ||
        err instanceof ServiceUnavailableException
      ) {
        throw new BedrockUnavailableError(err instanceof Error ? err.message : undefined);
      }
      if (err instanceof ThrottlingException) {
        throw new RateLimitError(
          'BEDROCK_THROTTLED',
          'AI is temporarily rate limited. Try again.',
          err instanceof Error ? err.message : undefined,
        );
      }
      throw err;
    }

    totalInputTokens += response.usage?.inputTokens ?? 0;
    totalOutputTokens += response.usage?.outputTokens ?? 0;

    const assistantContent: ContentBlock[] = response.output?.message?.content ?? [];
    messages.push({ role: 'assistant', content: assistantContent });

    const toolUseBlocks = assistantContent.filter((b): b is ContentBlock.ToolUseMember => 'toolUse' in b && Boolean(b.toolUse));
    const textBlocks = assistantContent.filter((b): b is ContentBlock.TextMember => 'text' in b && typeof b.text === 'string');

    for (const tb of textBlocks) {
      if (tb.text) {
        input.onEvent({ type: 'text_delta', chunk: tb.text });
        finalText += tb.text;
      }
    }

    if (toolUseBlocks.length === 0 || response.stopReason === 'end_turn') {
      break;
    }

    const toolResultBlocks: ContentBlock[] = [];
    for (const block of toolUseBlocks) {
      const toolUse = block.toolUse;
      if (!toolUse?.name || !toolUse.toolUseId) continue;
      const tool = toolMap.get(toolUse.name);
      if (!tool) {
        toolResultBlocks.push({
          toolResult: {
            toolUseId: toolUse.toolUseId,
            status: 'error',
            content: [{ text: `Unknown tool: ${toolUse.name}` }],
          },
        });
        continue;
      }

      toolCalls += 1;
      input.onEvent({ type: 'tool_call', name: tool.name, input: toolUse.input });

      let result: unknown;
      try {
        result = await tool.execute(toolUse.input, input.ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'tool error';
        input.onEvent({ type: 'tool_result', name: tool.name, summary: `error: ${message}` });
        toolResultBlocks.push({
          toolResult: {
            toolUseId: toolUse.toolUseId,
            status: 'error',
            content: [{ text: message }],
          },
        });
        continue;
      }

      const summary = summarizeToolResult(result);
      input.onEvent({ type: 'tool_result', name: tool.name, summary });
      toolResultBlocks.push({
        toolResult: {
          toolUseId: toolUse.toolUseId,
          status: 'success',
          content: [{ text: JSON.stringify(result).slice(0, 8000) }],
        },
      });
    }

    messages.push({ role: 'user', content: toolResultBlocks });

    if (response.stopReason !== 'tool_use') {
      break;
    }
  }

  return { finalText, toolCalls, inputTokens: totalInputTokens, outputTokens: totalOutputTokens };
};
