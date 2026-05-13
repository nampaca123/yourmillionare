// Unit tests for the shared CORS configuration module.

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { CorsHttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpMethod as LambdaHttpMethod } from 'aws-cdk-lib/aws-lambda';

import { buildApiGwCors, buildFunctionUrlCors, __test__ } from '../lib/config/cors.config.js';

const ORIGINAL_ENV = process.env.API_CORS_ALLOWED_ORIGINS;

describe('cors.config', () => {
  beforeEach(() => {
    delete process.env.API_CORS_ALLOWED_ORIGINS;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.API_CORS_ALLOWED_ORIGINS;
      return;
    }
    process.env.API_CORS_ALLOWED_ORIGINS = ORIGINAL_ENV;
  });

  describe('buildApiGwCors', () => {
    it('should fall back to localhost origins when env is unset in dev', () => {
      const config = buildApiGwCors({ stage: 'dev' });

      expect(config.allowOrigins).toEqual([...__test__.FALLBACK_LOCAL_ORIGINS]);
      expect(config.allowHeaders).toContain('Authorization');
      expect(config.allowHeaders).toContain('Content-Type');
      expect(config.allowHeaders).toContain('Idempotency-Key');
      expect(config.allowHeaders).toContain('Accept');
      expect(config.allowHeaders).toContain('Last-Event-Id');
      expect(config.allowMethods).toContain(CorsHttpMethod.POST);
      expect(config.allowMethods).toContain(CorsHttpMethod.DELETE);
      expect(config.allowCredentials).toBe(false);
    });

    it('should parse origins from env when set', () => {
      process.env.API_CORS_ALLOWED_ORIGINS = 'https://a.test, https://b.test';

      const config = buildApiGwCors({ stage: 'dev' });

      expect(config.allowOrigins).toEqual(['https://a.test', 'https://b.test']);
    });

    it('should throw when env is unset in prod and no allowedOrigins are passed', () => {
      delete process.env.API_CORS_ALLOWED_ORIGINS;

      const act = () => buildApiGwCors({ stage: 'prod' });

      expect(act).toThrowError(/API_CORS_ALLOWED_ORIGINS must be set/);
    });

    it('should use the explicit allowedOrigins arg without env lookup', () => {
      const config = buildApiGwCors({ stage: 'prod', allowedOrigins: ['https://prod.example.com'] });

      expect(config.allowOrigins).toEqual(['https://prod.example.com']);
    });

    it('should throw when env contains only commas/whitespace', () => {
      process.env.API_CORS_ALLOWED_ORIGINS = ' , , ';

      const act = () => buildApiGwCors({ stage: 'dev' });

      expect(act).toThrowError(/empty list/);
    });
  });

  describe('buildFunctionUrlCors', () => {
    it('should lowercase headers and include GET, POST, OPTIONS methods for SSE clients', () => {
      const config = buildFunctionUrlCors({ stage: 'dev' });

      expect(config.allowedHeaders).toContain('authorization');
      expect(config.allowedHeaders).toContain('content-type');
      expect(config.allowedHeaders).toContain('idempotency-key');
      expect(config.allowedHeaders).toContain('accept');
      expect(config.allowedHeaders).toContain('cache-control');
      expect(config.allowedHeaders).toContain('last-event-id');
      expect(config.allowedMethods).toContain(LambdaHttpMethod.POST);
      expect(config.allowedMethods).toContain(LambdaHttpMethod.GET);
      expect(config.allowedMethods).not.toContain(LambdaHttpMethod.OPTIONS);
      expect(config.exposedHeaders).toEqual(['content-type']);
    });

    it('should reuse the same origin resolution as API Gateway helper', () => {
      process.env.API_CORS_ALLOWED_ORIGINS = 'https://dashboard.example.com';

      const apiGw = buildApiGwCors({ stage: 'dev' });
      const fnUrl = buildFunctionUrlCors({ stage: 'dev' });

      expect(fnUrl.allowedOrigins).toEqual(apiGw.allowOrigins);
    });
  });
});
