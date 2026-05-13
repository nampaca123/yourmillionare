// Single source of truth for CORS across API Gateway HTTP API and Lambda Function URLs.

import { Duration } from 'aws-cdk-lib';
import { CorsHttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpMethod as LambdaHttpMethod } from 'aws-cdk-lib/aws-lambda';

const FALLBACK_LOCAL_ORIGINS = ['http://localhost:3000', 'http://localhost:5173'] as const;

// Headers commonly sent by SSE clients (Accept, Cache-Control, Last-Event-Id) and standard fetch (X-Requested-With) are included so Function URL preflights for moved-to-SSE routes do not silently drop CORS headers.
const ALLOWED_HEADERS_TITLE_CASE = [
  'Authorization',
  'Content-Type',
  'Idempotency-Key',
  'Accept',
  'Cache-Control',
  'Last-Event-Id',
  'X-Requested-With',
] as const;

const ALLOWED_API_GW_METHODS = [
  CorsHttpMethod.GET,
  CorsHttpMethod.POST,
  CorsHttpMethod.PATCH,
  CorsHttpMethod.DELETE,
  CorsHttpMethod.OPTIONS,
] as const;

// Function URLs auto-handle OPTIONS preflight; only the actual request methods are listed.
const ALLOWED_FUNCTION_URL_METHODS = [
  LambdaHttpMethod.GET,
  LambdaHttpMethod.POST,
] as const;

const CORS_PREFLIGHT_MAX_AGE = Duration.minutes(10);

export interface CorsConfigOptions {
  readonly stage: 'dev' | 'prod';
  readonly allowedOrigins?: ReadonlyArray<string>;
}

const resolveAllowedOrigins = (options: CorsConfigOptions): readonly string[] => {
  if (options.allowedOrigins && options.allowedOrigins.length > 0) {
    return options.allowedOrigins;
  }
  const raw = process.env.API_CORS_ALLOWED_ORIGINS;
  if (raw && raw.trim().length > 0) {
    const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (list.length === 0) {
      throw new Error('API_CORS_ALLOWED_ORIGINS is set but produced an empty list after parsing.');
    }
    return list;
  }
  if (options.stage === 'prod') {
    throw new Error('API_CORS_ALLOWED_ORIGINS must be set for prod deployments (frontend origins, comma-separated).');
  }
  return FALLBACK_LOCAL_ORIGINS;
};

export interface ApiGwCorsConfig {
  readonly allowOrigins: string[];
  readonly allowHeaders: string[];
  readonly allowMethods: CorsHttpMethod[];
  readonly allowCredentials: boolean;
  readonly maxAge: Duration;
}

export const buildApiGwCors = (options: CorsConfigOptions): ApiGwCorsConfig => ({
  allowOrigins: [...resolveAllowedOrigins(options)],
  allowHeaders: [...ALLOWED_HEADERS_TITLE_CASE],
  allowMethods: [...ALLOWED_API_GW_METHODS],
  allowCredentials: false,
  maxAge: CORS_PREFLIGHT_MAX_AGE,
});

export interface FunctionUrlCorsConfig {
  readonly allowedOrigins: string[];
  readonly allowedHeaders: string[];
  readonly allowedMethods: LambdaHttpMethod[];
  readonly exposedHeaders: string[];
  readonly maxAge: Duration;
}

export const buildFunctionUrlCors = (options: CorsConfigOptions): FunctionUrlCorsConfig => ({
  allowedOrigins: [...resolveAllowedOrigins(options)],
  allowedHeaders: ALLOWED_HEADERS_TITLE_CASE.map((header) => header.toLowerCase()),
  allowedMethods: [...ALLOWED_FUNCTION_URL_METHODS],
  exposedHeaders: ['content-type'],
  maxAge: CORS_PREFLIGHT_MAX_AGE,
});

export const __test__ = {
  FALLBACK_LOCAL_ORIGINS,
  ALLOWED_HEADERS_TITLE_CASE,
  ALLOWED_API_GW_METHODS,
  ALLOWED_FUNCTION_URL_METHODS,
  CORS_PREFLIGHT_MAX_AGE,
  resolveAllowedOrigins,
};
