// Port: triggers async seeding of filing_obligation rows for a freshly-created tenant.

export interface ObligationSeedDispatcher {
  seed(input: { tenantId: string }): Promise<void>;
}
