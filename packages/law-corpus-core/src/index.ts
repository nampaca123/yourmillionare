// Barrel export for @ym/law-corpus-core.

export type {
  LawType,
  OpenLawTarget,
  TargetLawDescriptor,
  LawRevision,
  LawChunk,
  LawChunkMetadataFilterable,
  LawChunkMetadataDisplay,
} from './types.js';
export { TARGET_LAW_REGISTRY } from './types.js';

export type { OpenLawArticle, ChunkBuildContext } from './chunk-builder.js';
export { buildChunks } from './chunk-builder.js';

export type { OpenLawDocument } from './law-document-parser.js';
export { parseOpenLawDocument } from './law-document-parser.js';
