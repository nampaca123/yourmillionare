// SSE event discriminated union streamed to the frontend during an agent run.

export type AgentSseEvent =
  | { type: 'started'; runId: string; scenario: string }
  | { type: 'context_ready'; keys: ReadonlyArray<string> }
  | { type: 'tool_call'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; summary: string; metadata?: Record<string, unknown> }
  | { type: 'text_delta'; chunk: string }
  | { type: 'final'; summary: string; metadata?: Record<string, unknown> }
  | { type: 'error'; reason: string; recoverable: boolean }
  | { type: 'done'; durationMs: number; toolCalls: number; tokens?: { input?: number; output?: number } };
