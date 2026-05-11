// Article-level chunk builder — turns 법제처 OPEN_LAW article payloads into KB-ready chunks with filterable metadata.

import type { LawChunk, LawChunkMetadataDisplay, LawChunkMetadataFilterable, LawType } from './types.js';

export interface OpenLawArticle {
  readonly articleNumber: string;
  readonly paragraph: string | null;
  readonly item: string | null;
  readonly text: string;
}

export interface ChunkBuildContext {
  readonly lawId: string;
  readonly lawName: string;
  readonly lawType: LawType;
  readonly ministry: string;
  readonly mst: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly revisionDate: string;
  readonly sourceUriBuilder: (lawId: string, mst: string, articleNumber: string) => string;
}

const compositeChunkId = (lawId: string, mst: string, article: OpenLawArticle): string => {
  const paragraph = article.paragraph ?? '';
  const item = article.item ?? '';
  return `${lawId}#${mst}#${article.articleNumber}#${paragraph}#${item}`;
};

export const buildChunks = (
  articles: ReadonlyArray<OpenLawArticle>,
  ctx: ChunkBuildContext,
): ReadonlyArray<LawChunk> =>
  articles.map((article) => {
    const filterable: LawChunkMetadataFilterable = {
      effectiveFrom: ctx.effectiveFrom,
      effectiveTo: ctx.effectiveTo,
      lawId: ctx.lawId,
      lawType: ctx.lawType,
      ministry: ctx.ministry,
      articleNumber: article.articleNumber,
    };
    const display: LawChunkMetadataDisplay = {
      lawName: ctx.lawName,
      sourceUri: ctx.sourceUriBuilder(ctx.lawId, ctx.mst, article.articleNumber),
      paragraph: article.paragraph,
      item: article.item,
      revisionDate: ctx.revisionDate,
    };
    return {
      chunkId: compositeChunkId(ctx.lawId, ctx.mst, article),
      content: article.text,
      filterable,
      display,
    };
  });
