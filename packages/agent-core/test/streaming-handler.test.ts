// Unit tests for withStreamingErrorBoundary covering happy path, AppError throws, and unexpected throws.

import { describe, it, expect, vi } from 'vitest';
import { UnauthorizedError } from '@ym/shared-errors';
import { withStreamingErrorBoundary } from '../src/streaming-handler.js';

const makeStubStream = () => {
  const chunks: string[] = [];
  let contentType = '';
  let ended = false;
  return {
    write(chunk: string): boolean {
      chunks.push(chunk);
      return true;
    },
    end(cb?: () => void): void {
      ended = true;
      cb?.();
    },
    setContentType(value: string): void {
      contentType = value;
    },
    inspect: () => ({ chunks, contentType, ended }),
  };
};

const parseEvents = (chunks: ReadonlyArray<string>): ReadonlyArray<Record<string, unknown>> =>
  chunks
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.replace(/^data: /, '').trim()) as Record<string, unknown>);

const silentLogger = { error: vi.fn() };

describe('withStreamingErrorBoundary', () => {
  it('should pass through the inner handler when no error is thrown', async () => {
    const stream = makeStubStream();
    const inner = vi.fn(async (_evt, s) => {
      s.write('data: {"type":"final","summary":"ok"}\n\n');
    });
    const wrapped = withStreamingErrorBoundary({ path: '/test' }, inner, silentLogger);

    await wrapped({ rawPath: '/test' }, stream);

    expect(inner).toHaveBeenCalledOnce();
    expect(stream.inspect().ended).toBe(true);
    expect(parseEvents(stream.inspect().chunks)).toEqual([{ type: 'final', summary: 'ok' }]);
  });

  it('should emit SSE error+done when inner throws UnauthorizedError', async () => {
    const stream = makeStubStream();
    const inner = vi.fn(async () => {
      throw new UnauthorizedError('bad token');
    });
    const wrapped = withStreamingErrorBoundary({ path: '/test' }, inner, silentLogger);

    await wrapped({ rawPath: '/test' }, stream);

    const events = parseEvents(stream.inspect().chunks);
    expect(events[0]).toMatchObject({ type: 'error', recoverable: true });
    expect(events[1]).toMatchObject({ type: 'done' });
    expect(stream.inspect().contentType).toBe('text/event-stream');
    expect(stream.inspect().ended).toBe(true);
  });

  it('should mark recoverable=false when a non-AppError throws', async () => {
    const stream = makeStubStream();
    const inner = vi.fn(async () => {
      throw new Error('database down');
    });
    const wrapped = withStreamingErrorBoundary({ path: '/test' }, inner, silentLogger);

    await wrapped({ rawPath: '/test' }, stream);

    const events = parseEvents(stream.inspect().chunks);
    expect(events[0]).toMatchObject({ type: 'error', reason: 'database down', recoverable: false });
  });

  it('should still close the stream even when writeSseEvent itself throws', async () => {
    const stream = {
      write: vi.fn(() => {
        throw new Error('stream torn down');
      }),
      end: vi.fn((cb?: () => void) => cb?.()),
      setContentType: vi.fn(),
    };
    const inner = vi.fn(async () => {
      throw new Error('inner');
    });
    const wrapped = withStreamingErrorBoundary({ path: '/test' }, inner, silentLogger);

    await wrapped({ rawPath: '/test' }, stream);

    expect(stream.end).toHaveBeenCalled();
  });
});
