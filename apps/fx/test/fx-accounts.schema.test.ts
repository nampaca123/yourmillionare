// Unit tests for fx-accounts inbound zod schemas — USD whitelist + balance bounds + CODEF discover/link.

import { describe, it, expect } from 'vitest';
import {
  DiscoverFxAccountsQuerySchema,
  LinkFxAccountBodySchema,
  RegisterFxAccountBodySchema,
  UpdateFxBalanceBodySchema,
} from '../src/infrastructure/inbound/http/fx-accounts.schema.js';

describe('RegisterFxAccountBodySchema', () => {
  it('should accept a USD account with a positive balance and an optional label', () => {
    const result = RegisterFxAccountBodySchema.safeParse({ currency: 'USD', balance: 1500, bankLabel: 'Citi USD' });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.currency).toBe('USD');
      expect(result.data.balance).toBe(1500);
      expect(result.data.bankLabel).toBe('Citi USD');
    }
  });

  it('should reject a non-USD currency for MVP', () => {
    const result = RegisterFxAccountBodySchema.safeParse({ currency: 'JPY', balance: 10000 });

    expect(result.success).toBe(false);
  });

  it('should reject zero or negative balances', () => {
    const zero = RegisterFxAccountBodySchema.safeParse({ currency: 'USD', balance: 0 });
    const negative = RegisterFxAccountBodySchema.safeParse({ currency: 'USD', balance: -1 });

    expect(zero.success).toBe(false);
    expect(negative.success).toBe(false);
  });

  it('should reject a bank label longer than 40 characters', () => {
    const result = RegisterFxAccountBodySchema.safeParse({
      currency: 'USD',
      balance: 100,
      bankLabel: 'x'.repeat(41),
    });

    expect(result.success).toBe(false);
  });
});

describe('UpdateFxBalanceBodySchema', () => {
  it('should accept a positive balance', () => {
    const result = UpdateFxBalanceBodySchema.safeParse({ balance: 999.99 });

    expect(result.success).toBe(true);
  });

  it('should reject a missing balance', () => {
    const result = UpdateFxBalanceBodySchema.safeParse({});

    expect(result.success).toBe(false);
  });
});

describe('DiscoverFxAccountsQuerySchema', () => {
  it('should accept a 4-digit CODEF organization code', () => {
    const result = DiscoverFxAccountsQuerySchema.safeParse({ organization: '0088' });

    expect(result.success).toBe(true);
  });

  it('should reject a non-4-digit organization code', () => {
    const tooShort = DiscoverFxAccountsQuerySchema.safeParse({ organization: '88' });
    const nonDigits = DiscoverFxAccountsQuerySchema.safeParse({ organization: 'SHIN' });

    expect(tooShort.success).toBe(false);
    expect(nonDigits.success).toBe(false);
  });

  it('should reject a missing organization', () => {
    const result = DiscoverFxAccountsQuerySchema.safeParse({});

    expect(result.success).toBe(false);
  });
});

describe('LinkFxAccountBodySchema', () => {
  it('should accept a valid organization with an account number and optional label', () => {
    const result = LinkFxAccountBodySchema.safeParse({
      organization: '0088',
      accountNumber: '110443478154',
      bankLabel: 'Shinhan USD',
    });

    expect(result.success).toBe(true);
  });

  it('should reject a missing account number', () => {
    const result = LinkFxAccountBodySchema.safeParse({ organization: '0088' });

    expect(result.success).toBe(false);
  });

  it('should reject a bank label longer than 40 characters', () => {
    const result = LinkFxAccountBodySchema.safeParse({
      organization: '0088',
      accountNumber: '110443478154',
      bankLabel: 'x'.repeat(41),
    });

    expect(result.success).toBe(false);
  });
});
