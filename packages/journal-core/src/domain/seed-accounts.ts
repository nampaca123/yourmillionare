// K-IFRS default chart of accounts seeds for tenant onboarding.

export interface SeedAccount {
  readonly code: string;
  readonly name: string;
  readonly displayName: string;
  readonly type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  readonly normalBalance: 'debit' | 'credit';
  readonly isCurrent: boolean | null;
}

export const K_IFRS_DEFAULT_ACCOUNTS: SeedAccount[] = [
  { code: '1001', name: '현금', displayName: '현금', type: 'asset', normalBalance: 'debit', isCurrent: true },
  { code: '1002', name: '보통예금', displayName: '통장에 있는 돈', type: 'asset', normalBalance: 'debit', isCurrent: true },
  { code: '1003', name: '당좌예금', displayName: '당좌예금', type: 'asset', normalBalance: 'debit', isCurrent: true },
  { code: '1004', name: '단기금융상품', displayName: '단기금융상품', type: 'asset', normalBalance: 'debit', isCurrent: true },
  { code: '1101', name: '매출채권', displayName: '받을 돈', type: 'asset', normalBalance: 'debit', isCurrent: true },
  { code: '1201', name: '재고자산', displayName: '재고', type: 'asset', normalBalance: 'debit', isCurrent: true },
  { code: '1301', name: '선급금', displayName: '미리 낸 돈', type: 'asset', normalBalance: 'debit', isCurrent: true },
  { code: '1302', name: '선급비용', displayName: '선납비용', type: 'asset', normalBalance: 'debit', isCurrent: true },
  { code: '1401', name: '유형자산', displayName: '건물·설비', type: 'asset', normalBalance: 'debit', isCurrent: false },
  { code: '1402', name: '감가상각누계액', displayName: '감가상각누계', type: 'asset', normalBalance: 'credit', isCurrent: false },
  { code: '1501', name: '보증금', displayName: '보증금(임차)', type: 'asset', normalBalance: 'debit', isCurrent: false },
  { code: '2001', name: '매입채무', displayName: '줄 돈', type: 'liability', normalBalance: 'credit', isCurrent: true },
  { code: '2101', name: '단기차입금', displayName: '단기 빌린 돈', type: 'liability', normalBalance: 'credit', isCurrent: true },
  { code: '2201', name: '미지급금', displayName: '아직 안 낸 비용', type: 'liability', normalBalance: 'credit', isCurrent: true },
  { code: '2301', name: '선수금', displayName: '미리 받은 돈', type: 'liability', normalBalance: 'credit', isCurrent: true },
  { code: '2102', name: '부가세예수금', displayName: '나라에 줄 부가세', type: 'liability', normalBalance: 'credit', isCurrent: true },
  { code: '2103', name: '부가세대급금', displayName: '돌려받을 부가세', type: 'liability', normalBalance: 'debit', isCurrent: true },
  { code: '2401', name: '예수금', displayName: '원천세 예수금', type: 'liability', normalBalance: 'credit', isCurrent: true },
  { code: '2403', name: '예수원천세', displayName: '예수 원천세', type: 'liability', normalBalance: 'credit', isCurrent: true },
  { code: '2501', name: '미지급세금', displayName: '미지급 세금', type: 'liability', normalBalance: 'credit', isCurrent: true },
  { code: '2601', name: '장기차입금', displayName: '장기 빌린 돈', type: 'liability', normalBalance: 'credit', isCurrent: false },
  { code: '2701', name: '임대보증금', displayName: '임대보증금', type: 'liability', normalBalance: 'credit', isCurrent: false },
  { code: '3001', name: '자본금', displayName: '자본금', type: 'equity', normalBalance: 'credit', isCurrent: null },
  { code: '3101', name: '이익잉여금', displayName: '이익잉여금', type: 'equity', normalBalance: 'credit', isCurrent: null },
  { code: '4001', name: '매출', displayName: '매출', type: 'revenue', normalBalance: 'credit', isCurrent: null },
  { code: '4002', name: '용역매출', displayName: '용역매출', type: 'revenue', normalBalance: 'credit', isCurrent: null },
  { code: '4003', name: '영세율매출', displayName: '영세율 매출(수출)', type: 'revenue', normalBalance: 'credit', isCurrent: null },
  { code: '4101', name: '이자수익', displayName: '이자수익', type: 'revenue', normalBalance: 'credit', isCurrent: null },
  { code: '4201', name: '기타수익', displayName: '기타수익', type: 'revenue', normalBalance: 'credit', isCurrent: null },
  { code: '4301', name: '외환차익', displayName: '외환차익', type: 'revenue', normalBalance: 'credit', isCurrent: null },
  { code: '5001', name: '매출원가', displayName: '매출원가', type: 'expense', normalBalance: 'debit', isCurrent: null },
  { code: '5101', name: '급여', displayName: '급여', type: 'expense', normalBalance: 'debit', isCurrent: null },
  { code: '5201', name: '복리후생비', displayName: '복리후생비', type: 'expense', normalBalance: 'debit', isCurrent: null },
  { code: '5301', name: '임차료', displayName: '임차료', type: 'expense', normalBalance: 'debit', isCurrent: null },
  { code: '5401', name: '통신비', displayName: '통신비', type: 'expense', normalBalance: 'debit', isCurrent: null },
  { code: '5402', name: '지급수수료', displayName: '지급수수료', type: 'expense', normalBalance: 'debit', isCurrent: null },
  { code: '5403', name: '회의비', displayName: '회의비', type: 'expense', normalBalance: 'debit', isCurrent: null },
  { code: '5404', name: '외주용역비', displayName: '외주용역비', type: 'expense', normalBalance: 'debit', isCurrent: null },
  { code: '5501', name: '소모품비', displayName: '소모품비', type: 'expense', normalBalance: 'debit', isCurrent: null },
  { code: '5502', name: '여비교통비', displayName: '여비교통비', type: 'expense', normalBalance: 'debit', isCurrent: null },
  { code: '5503', name: '광고선전비', displayName: '광고선전비', type: 'expense', normalBalance: 'debit', isCurrent: null },
  { code: '5601', name: '세금과공과', displayName: '세금과공과', type: 'expense', normalBalance: 'debit', isCurrent: null },
  { code: '5701', name: '외환차손', displayName: '외환차손', type: 'expense', normalBalance: 'debit', isCurrent: null },
];
