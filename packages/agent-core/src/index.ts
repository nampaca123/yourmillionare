// Barrel export for @ym/agent-core.

export { runAgent } from './agent-runner.js';
export type { RunAgentInput, RunAgentResult } from './agent-runner.js';
export type { AgentSseEvent } from './sse-event.types.js';
export type { Tool, ToolContext, JsonSchema } from './tool.types.js';
export { writeSseEvent, closeSseStream } from './sse-writer.js';
export type { SseSink } from './sse-writer.js';
export { verifyJwt } from './jwt-verifier.js';
export type { VerifiedClaims } from './jwt-verifier.js';
export { getBedrockClient, DEFAULT_MODEL_ID } from './bedrock-client.js';
