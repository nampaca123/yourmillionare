// KASI 특일정보 OPEN API adapter — fetches Korean public holidays for business-day roll-forward.

import { BedrockUnavailableError } from '@ym/shared-errors';

const KASI_BASE_URL = 'http://apis.data.go.kr/B090041/openapi/service/SpcdeInfoService/getRestDeInfo';
const FETCH_TIMEOUT_MS = 8_000;
const RESULT_CODE_OK = '00';

export interface KasiHolidayItem {
  readonly date: string;
  readonly name: string;
  readonly isHoliday: boolean;
  readonly isSubstitute: boolean;
}

interface KasiRawItem {
  readonly locdate: number | string;
  readonly dateName: string;
  readonly isHoliday: 'Y' | 'N';
}

interface KasiEnvelope {
  readonly response?: {
    readonly header?: { readonly resultCode?: string; readonly resultMsg?: string };
    readonly body?: { readonly items?: { readonly item?: KasiRawItem | ReadonlyArray<KasiRawItem> } };
  };
}

const toIso = (locdate: number | string): string => {
  const s = String(locdate);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
};

const detectSubstitute = (name: string): boolean => /대체공휴일/.test(name);

const normaliseItems = (items: KasiRawItem | ReadonlyArray<KasiRawItem> | undefined): ReadonlyArray<KasiRawItem> => {
  if (!items) return [];
  return Array.isArray(items) ? (items as ReadonlyArray<KasiRawItem>) : [items as KasiRawItem];
};

export interface KasiClientConfig {
  readonly serviceKey: string;
  readonly fetchImpl?: typeof fetch;
}

export class KasiHolidayClient {
  private readonly serviceKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: KasiClientConfig) {
    if (!config.serviceKey || config.serviceKey.length < 4) {
      throw new BedrockUnavailableError('HOLIDAY_API_SERVICE_KEY is missing or malformed');
    }
    this.serviceKey = config.serviceKey;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async fetchYear(year: number): Promise<ReadonlyArray<KasiHolidayItem>> {
    const params = new URLSearchParams({
      ServiceKey: this.serviceKey,
      solYear: String(year),
      _type: 'json',
      numOfRows: '100',
    });
    const url = `${KASI_BASE_URL}?${params.toString()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });
      if (!response.ok) {
        throw new BedrockUnavailableError(`KASI HTTP ${response.status}`);
      }
      const payload = (await response.json()) as KasiEnvelope;
      const code = payload.response?.header?.resultCode;
      if (code && code !== RESULT_CODE_OK) {
        throw new BedrockUnavailableError(`KASI error ${code}: ${payload.response?.header?.resultMsg ?? ''}`);
      }
      return normaliseItems(payload.response?.body?.items?.item).map((raw) => ({
        date: toIso(raw.locdate),
        name: raw.dateName,
        isHoliday: raw.isHoliday === 'Y',
        isSubstitute: detectSubstitute(raw.dateName),
      }));
    } finally {
      clearTimeout(timer);
    }
  }

  async fetchMonth(year: number, month: number): Promise<ReadonlyArray<KasiHolidayItem>> {
    const params = new URLSearchParams({
      ServiceKey: this.serviceKey,
      solYear: String(year),
      solMonth: String(month).padStart(2, '0'),
      _type: 'json',
      numOfRows: '50',
    });
    const url = `${KASI_BASE_URL}?${params.toString()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, { signal: controller.signal });
      if (!response.ok) {
        throw new BedrockUnavailableError(`KASI HTTP ${response.status}`);
      }
      const payload = (await response.json()) as KasiEnvelope;
      const code = payload.response?.header?.resultCode;
      if (code && code !== RESULT_CODE_OK) {
        throw new BedrockUnavailableError(`KASI error ${code}: ${payload.response?.header?.resultMsg ?? ''}`);
      }
      return normaliseItems(payload.response?.body?.items?.item).map((raw) => ({
        date: toIso(raw.locdate),
        name: raw.dateName,
        isHoliday: raw.isHoliday === 'Y',
        isSubstitute: detectSubstitute(raw.dateName),
      }));
    } finally {
      clearTimeout(timer);
    }
  }
}
