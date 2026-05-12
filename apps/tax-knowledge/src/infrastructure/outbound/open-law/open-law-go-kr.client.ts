// 법제처 OPEN_LAW DRF adapter — wraps lawSearch.do (list) and lawService.do (article body) endpoints.

import type { OpenLawTarget } from '@ym/law-corpus-core';
import { BedrockUnavailableError } from '@ym/shared-errors';

const SEARCH_BASE = 'http://www.law.go.kr/DRF/lawSearch.do';
const SERVICE_BASE = 'http://www.law.go.kr/DRF/lawService.do';
const FETCH_TIMEOUT_MS = 10_000;

export interface OpenLawSearchInput {
  readonly target: OpenLawTarget;
  readonly query?: string;
  readonly search?: 1 | 2;
  readonly display?: number;
  readonly page?: number;
  readonly efYd?: string;
  readonly extra?: Record<string, string>;
}

export interface OpenLawServiceInput {
  readonly target: OpenLawTarget;
  readonly lawId?: string;
  readonly mst?: string;
  readonly efYd?: string;
  readonly extra?: Record<string, string>;
}

export interface OpenLawClientConfig {
  readonly oc: string;
  readonly fetchImpl?: typeof fetch;
}

export class OpenLawClient {
  private readonly oc: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: OpenLawClientConfig) {
    if (!config.oc || config.oc.length < 4) {
      throw new BedrockUnavailableError('OPEN_LAW_OC is missing or malformed');
    }
    this.oc = config.oc;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async search(input: OpenLawSearchInput): Promise<unknown> {
    const params = new URLSearchParams({
      OC: this.oc,
      target: input.target,
      type: 'JSON',
      search: String(input.search ?? 1),
      display: String(input.display ?? 20),
      ...(input.query ? { query: input.query } : {}),
      ...(input.page ? { page: String(input.page) } : {}),
      ...(input.efYd ? { efYd: input.efYd } : {}),
      ...(input.extra ?? {}),
    });
    return this.invoke(`${SEARCH_BASE}?${params.toString()}`);
  }

  async getService(input: OpenLawServiceInput): Promise<unknown> {
    const params = new URLSearchParams({
      OC: this.oc,
      target: input.target,
      type: 'JSON',
      ...(input.lawId ? { ID: input.lawId } : {}),
      ...(input.mst ? { MST: input.mst } : {}),
      ...(input.efYd ? { efYd: input.efYd } : {}),
      ...(input.extra ?? {}),
    });
    return this.invoke(`${SERVICE_BASE}?${params.toString()}`);
  }

  private async invoke(url: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });
      if (!response.ok) {
        throw new BedrockUnavailableError(`OPEN_LAW HTTP ${response.status}`);
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (!contentType.includes('json')) {
        const body = await response.text();
        throw new BedrockUnavailableError(`OPEN_LAW returned non-JSON content-type ${contentType}: ${body.slice(0, 200)}`);
      }
      return response.json();
    } finally {
      clearTimeout(timer);
    }
  }
}
