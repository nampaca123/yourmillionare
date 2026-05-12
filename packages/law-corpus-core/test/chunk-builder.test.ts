// Unit tests for the law-corpus chunk builder — verifies deterministic chunkId + metadata mapping.

import { describe, it, expect } from 'vitest';
import {
  buildChunks,
  type ChunkBuildContext,
  type OpenLawArticle,
} from '../src/index.js';

const ctx: ChunkBuildContext = {
  lawId: '001584',
  lawName: '조세특례제한법',
  lawType: 'LAW',
  ministry: '기획재정부',
  mst: '20250101',
  effectiveFrom: '2025-01-01',
  effectiveTo: null,
  revisionDate: '2024-12-31',
  sourceUriBuilder: (lawId, mst, articleNumber) =>
    `s3://legal-kb/chunks/${lawId}/${mst}/article-${articleNumber}.json`,
};

const article6: OpenLawArticle = {
  articleNumber: '6',
  paragraph: '1',
  item: null,
  text: '제6조 제1항: 청년창업감면 본문 …',
};

describe('buildChunks', () => {
  it('should produce one chunk per article with a deterministic composite chunkId', () => {
    const chunks = buildChunks([article6], ctx);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.chunkId).toBe('001584#20250101#6#1#');
    expect(chunks[0]?.content).toBe('제6조 제1항: 청년창업감면 본문 …');
  });

  it('should populate filterable + display metadata with the requested values', () => {
    const [chunk] = buildChunks([article6], ctx);

    expect(chunk?.filterable).toMatchObject({
      lawId: '001584',
      lawType: 'LAW',
      articleNumber: '6',
      effectiveFrom: '2025-01-01',
      effectiveTo: null,
      ministry: '기획재정부',
    });
    expect(chunk?.display.sourceUri).toBe('s3://legal-kb/chunks/001584/20250101/article-6.json');
    expect(chunk?.display.paragraph).toBe('1');
    expect(chunk?.display.revisionDate).toBe('2024-12-31');
  });

  it('should emit distinct chunkIds for the same article number across different paragraphs and items', () => {
    const articles: OpenLawArticle[] = [
      { articleNumber: '6', paragraph: '1', item: null, text: '제6조 1항' },
      { articleNumber: '6', paragraph: '1', item: '가', text: '제6조 1항 가목' },
      { articleNumber: '6', paragraph: '2', item: null, text: '제6조 2항' },
    ];

    const ids = buildChunks(articles, ctx).map((c) => c.chunkId);

    expect(new Set(ids).size).toBe(3);
    expect(ids).toContain('001584#20250101#6#1#');
    expect(ids).toContain('001584#20250101#6#1#가');
    expect(ids).toContain('001584#20250101#6#2#');
  });
});
