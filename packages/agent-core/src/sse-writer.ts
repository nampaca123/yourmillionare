// Writes SSE events to the duck-typed responseStream provided by awslambda.streamifyResponse.

import type { AgentSseEvent } from './sse-event.types.js';

export interface SseSink {
  write(chunk: string): boolean | void;
  end(cb?: () => void): void;
}

export const writeSseEvent = (stream: SseSink, event: AgentSseEvent): void => {
  stream.write(`data: ${JSON.stringify(event)}\n\n`);
};

export const closeSseStream = (stream: SseSink): Promise<void> =>
  new Promise((resolve) => {
    stream.end(() => resolve());
  });
