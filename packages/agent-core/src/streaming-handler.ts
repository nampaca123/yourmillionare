// Wraps Function URL SSE handlers so any init/JWT/DB/Bedrock throw still flushes a structured SSE error and closes the stream.

import { AppError } from '@ym/shared-errors';
import type { SseSink } from './sse-writer.js';
import { closeSseStream, writeSseEvent } from './sse-writer.js';
import type { AgentSseEvent } from './sse-event.types.js';

export interface StreamingFunctionUrlEvent {
  readonly rawPath?: string;
  readonly body?: string;
  readonly isBase64Encoded?: boolean;
  readonly headers?: Record<string, string | undefined>;
  readonly requestContext?: {
    readonly requestId?: string;
  };
}

export interface StreamingResponseStream extends SseSink {
  setContentType?(type: string): void;
}

export interface StreamingHandlerOptions {
  readonly path: string;
}

type StreamingInnerHandler = (
  event: StreamingFunctionUrlEvent,
  stream: StreamingResponseStream,
) => Promise<void>;

interface ErrorLogger {
  error(payload: Record<string, unknown>, msg: string): void;
}

const fallbackLogger: ErrorLogger = {
  error: (payload, msg) => {
    process.stderr.write(`${JSON.stringify({ msg, ...payload })}\n`);
  },
};

const toReason = (err: unknown): { reason: string; recoverable: boolean } => {
  if (err instanceof AppError) {
    return { reason: err.userMessage, recoverable: err.statusCode < 500 };
  }
  if (err instanceof Error) {
    return { reason: err.message, recoverable: false };
  }
  return { reason: 'internal error', recoverable: false };
};

const safeWriteError = (stream: StreamingResponseStream, err: unknown, startedAt: number): void => {
  const { reason, recoverable } = toReason(err);
  const errorEvent: AgentSseEvent = { type: 'error', reason, recoverable };
  const doneEvent: AgentSseEvent = { type: 'done', durationMs: Date.now() - startedAt, toolCalls: 0 };
  try {
    stream.setContentType?.('text/event-stream');
    writeSseEvent(stream, errorEvent);
    writeSseEvent(stream, doneEvent);
  } catch {
    return;
  }
};

export const withStreamingErrorBoundary = (
  options: StreamingHandlerOptions,
  inner: StreamingInnerHandler,
  logger: ErrorLogger = fallbackLogger,
): StreamingInnerHandler => async (event, stream) => {
  const startedAt = Date.now();
  try {
    await inner(event, stream);
  } catch (err) {
    const logPayload: Record<string, unknown> = {
      path: event.rawPath ?? options.path,
      requestId: event.requestContext?.requestId,
      err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : err,
    };
    if (err instanceof AppError && err.statusCode < 500) {
      logger.error(logPayload, `streaming handler client error on ${options.path}`);
    } else {
      logger.error(logPayload, `streaming handler unhandled error on ${options.path}`);
    }
    safeWriteError(stream, err, startedAt);
  } finally {
    await closeSseStream(stream).catch(() => undefined);
  }
};
