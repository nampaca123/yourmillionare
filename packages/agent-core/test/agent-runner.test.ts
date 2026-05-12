// Unit tests for the agent runner using a mocked Bedrock client via in-memory tool resolution.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Tool, ToolContext } from '../src/tool.types.js';
import type { AgentSseEvent } from '../src/sse-event.types.js';

const ctx: ToolContext = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  userId: '22222222-2222-2222-2222-222222222222',
  cognitoSub: 'cog-sub-1',
};

const makeStubTool = (name: string, value: unknown): Tool => ({
  name,
  description: `stub ${name}`,
  inputSchema: { type: 'object', properties: {}, additionalProperties: true },
  execute: vi.fn().mockResolvedValue(value),
});

const mockSend = vi.fn();
vi.mock('@aws-sdk/client-bedrock-runtime', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-bedrock-runtime')>(
    '@aws-sdk/client-bedrock-runtime',
  );
  return {
    ...actual,
    BedrockRuntimeClient: vi.fn().mockImplementation(() => ({ send: mockSend })),
  };
});

describe('runAgent', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('should call a tool and emit tool_call+tool_result events when the model uses it', async () => {
    const { runAgent } = await import('../src/agent-runner.js');
    mockSend
      .mockResolvedValueOnce({
        stopReason: 'tool_use',
        output: {
          message: {
            role: 'assistant',
            content: [{ toolUse: { name: 'echo', toolUseId: 'tu1', input: { value: 'hi' } } }],
          },
        },
        usage: { inputTokens: 10, outputTokens: 5 },
      })
      .mockResolvedValueOnce({
        stopReason: 'end_turn',
        output: {
          message: {
            role: 'assistant',
            content: [{ text: 'final response with tool output' }],
          },
        },
        usage: { inputTokens: 15, outputTokens: 8 },
      });

    const events: AgentSseEvent[] = [];
    const result = await runAgent({
      systemPrompt: 'You are a test agent.',
      userMessage: 'do the thing',
      tools: [makeStubTool('echo', { ok: true })],
      ctx,
      onEvent: (e) => events.push(e),
    });

    expect(events.some((e) => e.type === 'tool_call' && e.name === 'echo')).toBe(true);
    expect(events.some((e) => e.type === 'tool_result' && e.name === 'echo')).toBe(true);
    expect(events.some((e) => e.type === 'text_delta')).toBe(true);
    expect(result.toolCalls).toBe(1);
    expect(result.inputTokens).toBe(25);
    expect(result.outputTokens).toBe(13);
    expect(result.finalText).toContain('final response');
  });

  it('should stop iterating when model returns end_turn with no tools', async () => {
    const { runAgent } = await import('../src/agent-runner.js');
    mockSend.mockResolvedValueOnce({
      stopReason: 'end_turn',
      output: { message: { role: 'assistant', content: [{ text: 'direct answer' }] } },
      usage: { inputTokens: 5, outputTokens: 2 },
    });

    const events: AgentSseEvent[] = [];
    const result = await runAgent({
      systemPrompt: '',
      userMessage: 'hi',
      tools: [],
      ctx,
      onEvent: (e) => events.push(e),
    });

    expect(result.toolCalls).toBe(0);
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('should respect maxIterations when model keeps requesting tools', async () => {
    const { runAgent } = await import('../src/agent-runner.js');
    const toolUseResponse = {
      stopReason: 'tool_use',
      output: {
        message: {
          role: 'assistant',
          content: [{ toolUse: { name: 'echo', toolUseId: 'x', input: {} } }],
        },
      },
      usage: { inputTokens: 1, outputTokens: 1 },
    };
    mockSend.mockResolvedValue(toolUseResponse);

    const result = await runAgent({
      systemPrompt: '',
      userMessage: 'loop',
      tools: [makeStubTool('echo', {})],
      ctx,
      onEvent: () => undefined,
      maxIterations: 3,
    });

    expect(mockSend).toHaveBeenCalledTimes(3);
    expect(result.toolCalls).toBe(3);
  });

  it('should report tool errors via tool_result event and continue', async () => {
    const { runAgent } = await import('../src/agent-runner.js');
    mockSend
      .mockResolvedValueOnce({
        stopReason: 'tool_use',
        output: {
          message: { role: 'assistant', content: [{ toolUse: { name: 'flaky', toolUseId: 'y', input: {} } }] },
        },
        usage: { inputTokens: 1, outputTokens: 1 },
      })
      .mockResolvedValueOnce({
        stopReason: 'end_turn',
        output: { message: { role: 'assistant', content: [{ text: 'recovered' }] } },
        usage: { inputTokens: 1, outputTokens: 1 },
      });

    const flaky: Tool = {
      name: 'flaky',
      description: 'fails',
      inputSchema: { type: 'object' },
      execute: vi.fn().mockRejectedValue(new Error('boom')),
    };

    const events: AgentSseEvent[] = [];
    const result = await runAgent({
      systemPrompt: '',
      userMessage: 'go',
      tools: [flaky],
      ctx,
      onEvent: (e) => events.push(e),
    });

    expect(result.toolCalls).toBe(1);
    expect(events.some((e) => e.type === 'tool_result' && e.summary.startsWith('error:'))).toBe(true);
  });
});
