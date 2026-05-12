// Pure VAT calculator — rates are injected by the caller from the effective-dated tax_rule table.

const KRW_DECIMALS = 0;

export interface VatLineInput {
  readonly supply: number;
  readonly rate: number;
}

export interface VatComputationResult {
  readonly outputVat: number;
  readonly deductibleInputVat: number;
  readonly netPayable: number;
  readonly penalty: number;
}

export const roundKrw = (value: number): number => {
  const factor = 10 ** KRW_DECIMALS;
  return Math.round(value * factor) / factor;
};

export const computeVatPayable = (
  outputs: ReadonlyArray<VatLineInput>,
  deductibleInputs: ReadonlyArray<VatLineInput>,
  penalty = 0,
): VatComputationResult => {
  const outputVat = outputs.reduce((sum, line) => sum + line.supply * line.rate, 0);
  const deductibleInputVat = deductibleInputs.reduce((sum, line) => sum + line.supply * line.rate, 0);
  const netPayable = outputVat - deductibleInputVat + penalty;
  return {
    outputVat: roundKrw(outputVat),
    deductibleInputVat: roundKrw(deductibleInputVat),
    netPayable: roundKrw(netPayable),
    penalty: roundKrw(penalty),
  };
};

export const splitGrossIntoSupplyAndVat = (
  gross: number,
  vatRate: number,
): { supply: number; vat: number } => {
  if (vatRate <= 0) {
    return { supply: gross, vat: 0 };
  }
  const supply = gross / (1 + vatRate);
  return { supply: roundKrw(supply), vat: roundKrw(gross - supply) };
};
