// Unit tests for the foreign-currency CODEF transaction client (FCY decimal parsing + signed amount + balance fallback).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

vi.mock('../src/infrastructure/outbound/codef/codef-auth.client.js', () => ({
  getAccessToken: vi.fn().mockResolvedValue('test-token'),
}));

import { fetchForeignTransactions } from '../src/infrastructure/outbound/codef/codef-fx-bank.client.js';

const buildOkResponse = (payload: unknown): Response =>
  ({
    ok: true,
    text: async () => encodeURIComponent(JSON.stringify(payload)),
  }) as unknown as Response;

describe('fetchForeignTransactions', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should parse positive deposits as in-amounts and decimal cents preserved', async () => {
    fetchMock.mockResolvedValueOnce(
      buildOkResponse({
        result: { code: 'CF-00000', message: 'OK' },
        data: {
          resAccountBalance: '1500.50',
          resTrHistoryList: [
            {
              resAccountTrDate: '20260301',
              resAccountTrTime: '101500',
              resAccountIn: '250.75',
              resAccountOut: '0',
              resAfterTranBalance: '1500.50',
            },
          ],
        },
      }),
    );

    const result = await fetchForeignTransactions({
      connectedId: 'conn-1',
      organization: '0088',
      accountNumber: '11044',
      startDate: '20260301',
      endDate: '20260331',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.transactions).toHaveLength(1);
    const first = result.data.transactions[0];
    expect(first).toBeDefined();
    expect(first?.fcyAmount).toBeCloseTo(250.75);
    expect(result.data.balance?.currentBalanceFcy).toBeCloseTo(1500.5);
  });

  it('should treat outflows as negative FCY amounts', async () => {
    fetchMock.mockResolvedValueOnce(
      buildOkResponse({
        result: { code: 'CF-00000', message: 'OK' },
        data: {
          resAccountBalance: '900.00',
          resTrHistoryList: [
            {
              resAccountTrDate: '20260302',
              resAccountTrTime: '120000',
              resAccountIn: '0',
              resAccountOut: '100.25',
              resAfterTranBalance: '900.00',
            },
          ],
        },
      }),
    );

    const result = await fetchForeignTransactions({
      connectedId: 'conn-1',
      organization: '0088',
      accountNumber: '11044',
      startDate: '20260301',
      endDate: '20260331',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.transactions[0]?.fcyAmount).toBeCloseTo(-100.25);
  });

  it('should fall back to last row balance when resAccountBalance missing', async () => {
    fetchMock.mockResolvedValueOnce(
      buildOkResponse({
        result: { code: 'CF-00000', message: 'OK' },
        data: {
          resTrHistoryList: [
            {
              resAccountTrDate: '20260301',
              resAccountIn: '50.00',
              resAccountOut: '0',
              resAfterTranBalance: '750.25',
            },
            {
              resAccountTrDate: '20260315',
              resAccountIn: '0',
              resAccountOut: '25.50',
              resAfterTranBalance: '724.75',
            },
          ],
        },
      }),
    );

    const result = await fetchForeignTransactions({
      connectedId: 'conn-1',
      organization: '0088',
      accountNumber: '11044',
      startDate: '20260301',
      endDate: '20260331',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.balance?.currentBalanceFcy).toBeCloseTo(724.75);
  });

  it('should return ok=false with the CODEF error code when result.code is non-success', async () => {
    fetchMock.mockResolvedValueOnce(
      buildOkResponse({
        result: { code: 'CF-12345', message: 'Account locked' },
        data: { resTrHistoryList: [] },
      }),
    );

    const result = await fetchForeignTransactions({
      connectedId: 'conn-1',
      organization: '0088',
      accountNumber: '11044',
      startDate: '20260301',
      endDate: '20260331',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('CF-12345');
    expect(result.message).toBe('Account locked');
  });

  it('should return ok=false with HTTP status when network response is not ok', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 502, text: async () => '' } as unknown as Response);

    const result = await fetchForeignTransactions({
      connectedId: 'conn-1',
      organization: '0088',
      accountNumber: '11044',
      startDate: '20260301',
      endDate: '20260331',
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('HTTP-502');
  });
});
