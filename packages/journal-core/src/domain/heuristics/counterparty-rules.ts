// Counterparty regex rules feeding the heuristic first-pass classifier (PLAN.md §1.4 5-second promise).

export interface HeuristicRule {
  readonly id: string;
  readonly counterpartyPattern: RegExp;
  readonly minAmount?: number;
  readonly maxAmount?: number;
  readonly suggestedAccountCode: string;
  readonly confidence: number;
  readonly flags?: ReadonlyArray<'withholding_candidate' | 'meal_expense_review' | 'capex_review'>;
  readonly description: string;
}

const TEN_MILLION_KRW = 10_000_000;
const HUNDRED_THOUSAND_KRW = 100_000;

export const COUNTERPARTY_RULES: ReadonlyArray<HeuristicRule> = [
  {
    id: 'counterparty:cafe',
    counterpartyPattern: /^(스타벅스|투썸|컴포즈|메가커피|이디야|할리스|커피빈|폴바셋)/,
    suggestedAccountCode: '5402',
    confidence: 0.55,
    flags: ['meal_expense_review'],
    description: 'Cafe chain — likely 회의비 or 접대비. Surface to user for confirmation',
  },
  {
    id: 'counterparty:cloud',
    counterpartyPattern: /^(AWS|아마존웹서비스|GCP|구글클라우드|네이버클라우드|MS\s*AZURE)/i,
    suggestedAccountCode: '5402',
    confidence: 0.7,
    description: 'Cloud provider — 지급수수료',
  },
  {
    id: 'counterparty:saas',
    counterpartyPattern: /^(NOTION|FIGMA|SLACK|GITHUB|JIRA|ATLASSIAN|LINEAR)/i,
    suggestedAccountCode: '5402',
    confidence: 0.7,
    description: 'SaaS subscription — 지급수수료',
  },
  {
    id: 'counterparty:ecommerce',
    counterpartyPattern: /^(쿠팡|11번가|G마켓|옥션|네이버쇼핑|배달의민족|요기요)/,
    suggestedAccountCode: '5501',
    confidence: 0.6,
    description: 'E-commerce — 소모품비 (배달의민족은 회의비 후보)',
  },
  {
    id: 'counterparty:transfer-payroll',
    counterpartyPattern: /^.+/,
    minAmount: HUNDRED_THOUSAND_KRW,
    suggestedAccountCode: '5101',
    confidence: 0.35,
    flags: ['withholding_candidate'],
    description: 'Generic outbound ≥ 100k KRW — flag as 사업소득 candidate for 원천세 review',
  },
  {
    id: 'counterparty:nts',
    counterpartyPattern: /^(국세청|세무서|홈택스)/,
    suggestedAccountCode: '2501',
    confidence: 0.8,
    description: 'NTS payment — 미지급세금 / 세금과공과',
  },
  {
    id: 'counterparty:rent',
    counterpartyPattern: /(월세|임대료|임차료|RENT)/i,
    suggestedAccountCode: '5301',
    confidence: 0.75,
    description: 'Rent — 임차료',
  },
  {
    id: 'counterparty:telecom',
    counterpartyPattern: /^(KT|SKT|LG\s*U\+|SK\s*텔레콤|KT\s*올레)/i,
    suggestedAccountCode: '5401',
    confidence: 0.75,
    description: 'Telecom — 통신비',
  },
  {
    id: 'counterparty:capex',
    counterpartyPattern: /^.+/,
    minAmount: TEN_MILLION_KRW,
    suggestedAccountCode: '1401',
    confidence: 0.3,
    flags: ['capex_review'],
    description: 'Outbound ≥ 10M KRW — flag for capex vs expense review',
  },
];

export interface HeuristicMatch {
  readonly ruleId: string;
  readonly accountCode: string;
  readonly confidence: number;
  readonly flags: ReadonlyArray<string>;
  readonly description: string;
}

export interface HeuristicInput {
  readonly counterparty: string;
  readonly amount: number;
  readonly direction: 'in' | 'out';
}

export const matchHeuristic = (input: HeuristicInput): HeuristicMatch | null => {
  for (const rule of COUNTERPARTY_RULES) {
    if (rule.minAmount !== undefined && input.amount < rule.minAmount) continue;
    if (rule.maxAmount !== undefined && input.amount > rule.maxAmount) continue;
    if (!rule.counterpartyPattern.test(input.counterparty)) continue;
    return {
      ruleId: rule.id,
      accountCode: rule.suggestedAccountCode,
      confidence: rule.confidence,
      flags: rule.flags ?? [],
      description: rule.description,
    };
  }
  return null;
};
