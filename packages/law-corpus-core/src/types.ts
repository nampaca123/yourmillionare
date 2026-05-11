// Law corpus value objects shared between the OPEN_LAW sync Lambda and the Bedrock KB chunk metadata writer.

export type LawType = 'LAW' | 'DECREE' | 'REGULATION' | 'INTERPRETATION' | 'BYLAW';

export type OpenLawTarget =
  | 'law'
  | 'lsHstInf'
  | 'eflaw'
  | 'oldAndNew'
  | 'admrul'
  | 'ordin'
  | 'licbyl'
  | 'lstrm'
  | 'ntsCgmExpc'
  | 'delHst'
  | 'lsClsfd'
  | 'lnkLs';

export interface TargetLawDescriptor {
  readonly lawId: string;
  readonly lawName: string;
  readonly target: OpenLawTarget;
  readonly lawType: LawType;
  readonly ministry: string;
}

export interface LawRevision {
  readonly lawId: string;
  readonly mst: string;
  readonly effectiveFrom: string;
  readonly publishedAt: string | null;
  readonly revisionType: 'ENACTMENT' | 'AMENDMENT' | 'WHOLESALE_AMENDMENT' | 'REPEAL';
}

export interface LawChunkMetadataFilterable {
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly lawId: string;
  readonly lawType: LawType;
  readonly ministry: string;
  readonly articleNumber: string;
}

export interface LawChunkMetadataDisplay {
  readonly lawName: string;
  readonly sourceUri: string;
  readonly paragraph: string | null;
  readonly item: string | null;
  readonly revisionDate: string;
}

export interface LawChunk {
  readonly chunkId: string;
  readonly content: string;
  readonly filterable: LawChunkMetadataFilterable;
  readonly display: LawChunkMetadataDisplay;
}

export const TARGET_LAW_REGISTRY: ReadonlyArray<TargetLawDescriptor> = [
  { lawId: '001706', lawName: '조세특례제한법', target: 'law', lawType: 'LAW', ministry: '기획재정부' },
  { lawId: 'VAT_LAW',     lawName: '부가가치세법', target: 'law', lawType: 'LAW', ministry: '기획재정부' },
  { lawId: 'CORP_TAX',    lawName: '법인세법', target: 'law', lawType: 'LAW', ministry: '기획재정부' },
  { lawId: 'INCOME_TAX',  lawName: '소득세법', target: 'law', lawType: 'LAW', ministry: '기획재정부' },
  { lawId: 'BASIC_NTS',   lawName: '국세기본법', target: 'law', lawType: 'LAW', ministry: '기획재정부' },
  { lawId: 'LOCAL_TAX',   lawName: '지방세법', target: 'law', lawType: 'LAW', ministry: '행정안전부' },
];
