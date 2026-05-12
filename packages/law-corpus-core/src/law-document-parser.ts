// Parses 법제처 OPEN_LAW JSON envelope into article-level inputs ready for chunk-builder.

import type { OpenLawArticle } from './chunk-builder.js';

export interface OpenLawDocument {
  readonly metadata: {
    readonly lawId: string;
    readonly lawNameKo: string;
    readonly ministry: string;
    readonly effectiveFromYmd: string;
    readonly publishedYmd: string;
  };
  readonly articles: ReadonlyArray<OpenLawArticle>;
}

interface RawHo {
  readonly 호번호?: string;
  readonly 호내용?: string;
}

interface RawArticleParagraph {
  readonly 항번호?: string;
  readonly 항내용?: string;
  readonly 호?: RawHo | ReadonlyArray<RawHo>;
}

interface RawArticle {
  readonly 조문번호?: string | number;
  readonly 조문제목?: string;
  readonly 조문내용?: string;
  readonly 조문여부?: string;
  readonly 조문시행일자?: string | number;
  readonly 항?: RawArticleParagraph | ReadonlyArray<RawArticleParagraph>;
}

interface RawEnvelope {
  readonly 법령?: {
    readonly 기본정보?: {
      readonly 법령ID?: string;
      readonly 법령명_한글?: string;
      readonly 시행일자?: string | number;
      readonly 공포일자?: string | number;
      readonly 소관부처?: { content?: string };
    };
    readonly 조문?: {
      readonly 조문단위?: RawArticle | ReadonlyArray<RawArticle>;
    };
  };
}

const fmtYmd = (ymd: string | number | undefined): string => {
  if (!ymd) return '';
  const s = String(ymd);
  if (s.length !== 8) return s;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
};

const toArray = <T>(value: T | ReadonlyArray<T> | undefined): ReadonlyArray<T> => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? (value as ReadonlyArray<T>) : [value as T];
};

const paragraphToText = (p: RawArticleParagraph): string => {
  const hoText = toArray(p.호).map((h) => `  ${h.호번호 ?? ''} ${h.호내용 ?? ''}`).join('\n');
  return `${p.항번호 ?? ''} ${p.항내용 ?? ''}${hoText ? `\n${hoText}` : ''}`.trim();
};

const safeString = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return '';
};

const articleToText = (raw: RawArticle): string => {
  const header = `제${safeString(raw.조문번호)}조 ${safeString(raw.조문제목)}`.trim();
  const body = safeString(raw.조문내용).trim();
  const paragraphs = toArray(raw.항).map(paragraphToText).filter(Boolean).join('\n');
  return [header, body, paragraphs].filter(Boolean).join('\n');
};

const SKIPPED_KIND = '전문';

export const parseOpenLawDocument = (
  payload: unknown,
  fallback: { lawId: string; lawName: string; ministry: string; effectiveFrom: string },
): OpenLawDocument => {
  const env = payload as RawEnvelope;
  const law = env.법령;
  const base = law?.기본정보;
  const lawId = base?.법령ID ?? fallback.lawId;
  const lawNameKo = base?.법령명_한글 ?? fallback.lawName;
  const ministry = base?.소관부처?.content ?? fallback.ministry;
  const effectiveFromYmd = fmtYmd(base?.시행일자) || fallback.effectiveFrom;
  const publishedYmd = fmtYmd(base?.공포일자);

  const rawArticles = toArray(law?.조문?.조문단위);
  const articles: OpenLawArticle[] = rawArticles
    .filter((a) => a.조문여부 !== SKIPPED_KIND && a.조문번호 !== undefined)
    .map((a) => ({
      articleNumber: String(a.조문번호 ?? ''),
      paragraph: null,
      item: null,
      text: articleToText(a),
    }));

  return {
    metadata: { lawId, lawNameKo, ministry, effectiveFromYmd, publishedYmd },
    articles,
  };
};
