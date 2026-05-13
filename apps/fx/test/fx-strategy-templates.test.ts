// Unit tests for fx-strategy-templates — scenario whitelist + user-message body shape.

import { describe, it, expect } from 'vitest';
import {
  FX_SCENARIOS,
  buildFxUserMessage,
  getFxSystemPrompt,
  isFxScenario,
} from '../src/application/fx-strategy-templates.js';

const fixtureCtx = {
  today: '2026-05-13',
  foreignBalances: [
    {
      account_id: 'a1',
      source: 'manual' as const,
      currency: 'USD',
      bank_label: 'Citi USD',
      balance_fcy: 1500,
      balance_krw_today: 2226450,
      last_synced_at: '2026-05-13T06:15:07.451Z',
    },
  ],
  fxTodayUsdKrw: 1484.3,
  fxTrend30d: [{ observed_on: '2026-05-13', rate: 1484.3 }],
  fxTrend90d: [],
  fxVolatilityPct30d: 0.85,
  contextKeys: ['today', 'foreign_balances'],
};

describe('FX scenario whitelist', () => {
  it('should expose exposure_summary, convert_now_check, monthly_outlook as the only scenarios', () => {
    expect([...FX_SCENARIOS]).toEqual(['exposure_summary', 'convert_now_check', 'monthly_outlook']);
  });

  it('should reject unknown scenario names', () => {
    expect(isFxScenario('exposure_summary')).toBe(true);
    expect(isFxScenario('hedge_recommendation')).toBe(false);
  });
});

describe('FX system prompt', () => {
  it('should include the 7-step structure and conditional-recommendation rule', () => {
    const prompt = getFxSystemPrompt();

    expect(prompt).toContain('7단 마크다운 구조');
    expect(prompt).toContain('현재 노출 요약');
    expect(prompt).toContain('위험 경고');
    expect(prompt).toContain('파생상품');
  });
});

describe('buildFxUserMessage', () => {
  it('should inject the user balance and today rate into exposure_summary message', () => {
    const message = buildFxUserMessage('exposure_summary', fixtureCtx);

    expect(message).toContain('2026-05-13');
    expect(message).toContain('Citi USD');
    expect(message).toContain('1484.30');
    expect(message).toContain('0.85%');
  });

  it('should add 90-day trend block only for monthly_outlook', () => {
    const summary = buildFxUserMessage('exposure_summary', fixtureCtx);
    const outlook = buildFxUserMessage('monthly_outlook', fixtureCtx);

    expect(summary).not.toContain('최근 90일 USD/KRW 추세');
    expect(outlook).toContain('최근 90일 USD/KRW 추세');
  });
});
