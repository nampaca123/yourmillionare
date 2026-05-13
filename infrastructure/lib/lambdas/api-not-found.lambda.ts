// Catch-all Lambda for API Gateway HTTP API $default route: returns 404 with hints for moved-to-Function-URL routes so unmatched requests no longer surface as browser CORS errors.

const STATIC_FUNCTION_URL_HINTS: ReadonlyArray<{
  readonly pathSuffix: string;
  readonly envVar: string;
  readonly description: string;
}> = [
  {
    pathSuffix: '/fs/sync',
    envVar: 'CODEF_SYNC_STREAM_FN_URL',
    description: 'POST /tenants/{tenantId}/fs/sync moved to a Lambda Function URL (SSE Response Streaming).',
  },
  {
    pathSuffix: '/tax/strategy',
    envVar: 'TAX_STRATEGY_FN_URL',
    description: 'POST /tenants/{tenantId}/tax/strategy moved to a Lambda Function URL (SSE Response Streaming).',
  },
];

interface ApiGwV2Event {
  readonly rawPath?: string;
  readonly requestContext?: {
    readonly http?: { readonly method?: string; readonly path?: string };
    readonly requestId?: string;
  };
}

interface ApiGwV2Response {
  readonly statusCode: number;
  readonly headers?: Record<string, string>;
  readonly body: string;
}

const resolveHint = (path: string): { description: string; movedTo?: string } | null => {
  for (const hint of STATIC_FUNCTION_URL_HINTS) {
    if (path.endsWith(hint.pathSuffix)) {
      const url = process.env[hint.envVar];
      return {
        description: hint.description,
        movedTo: url && url.trim().length > 0 ? url : undefined,
      };
    }
  }
  return null;
};

export const handler = async (event: ApiGwV2Event): Promise<ApiGwV2Response> => {
  const method = event.requestContext?.http?.method ?? 'UNKNOWN';
  const path = event.requestContext?.http?.path ?? event.rawPath ?? '/';
  const requestId = event.requestContext?.requestId;

  const hint = resolveHint(path);
  if (hint) {
    return {
      statusCode: 404,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        error: {
          code: 'ROUTE_MOVED_TO_FUNCTION_URL',
          message: hint.description,
          method,
          path,
          movedTo: hint.movedTo ?? null,
          requestId: requestId ?? null,
        },
      }),
    };
  }

  return {
    statusCode: 404,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      error: {
        code: 'ROUTE_NOT_FOUND',
        message: `No route registered for ${method} ${path}.`,
        method,
        path,
        requestId: requestId ?? null,
      },
    }),
  };
};
