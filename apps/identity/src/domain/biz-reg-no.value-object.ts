// BizRegNo value object: validates Korean 10-digit business registration number format.

import { InvalidBizRegNoError } from './identity.errors.js';

const BIZ_REG_NO_PATTERN = /^\d{3}-\d{2}-\d{5}$/;
const BIZ_REG_NO_RAW_PATTERN = /^\d{10}$/;

export type BizRegNo = string & { readonly _brand: 'BizRegNo' };

export const parseBizRegNo = (raw: string): BizRegNo => {
  const normalized = raw.replace(/-/g, '');
  if (!BIZ_REG_NO_RAW_PATTERN.test(normalized)) {
    throw new InvalidBizRegNoError(raw);
  }
  const formatted = `${normalized.slice(0, 3)}-${normalized.slice(3, 5)}-${normalized.slice(5)}`;
  if (!BIZ_REG_NO_PATTERN.test(formatted)) {
    throw new InvalidBizRegNoError(raw);
  }
  return formatted as BizRegNo;
};

export const bizRegNoRaw = (brn: BizRegNo): string => brn.replace(/-/g, '');
