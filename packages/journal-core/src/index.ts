export * from './domain/journal-entry.entity.js';
export * from './domain/journal-line.value-object.js';
export * from './domain/journal.errors.js';
export * from './domain/seed-accounts.js';

export type { HeuristicRule, HeuristicMatch, HeuristicInput } from './domain/heuristics/counterparty-rules.js';
export { COUNTERPARTY_RULES, matchHeuristic } from './domain/heuristics/counterparty-rules.js';

export type {
  ClassifyInput,
  ClassifyResult,
  TransactionClassifier,
} from './application/ports/transaction-classifier.port.js';
export type { CacheProjector } from './application/ports/cache-projector.port.js';
export type { JournalRepository, JournalEntrySummary } from './application/ports/journal.repository.port.js';

export { BedrockConverseClassifier } from './infrastructure/bedrock/bedrock-converse.classifier.js';
export { DeterministicStubClassifier } from './infrastructure/stub/deterministic-stub.classifier.js';
export { DdbCacheProjectorAdapter } from './infrastructure/ddb/ddb-cache-projector.adapter.js';
export { PgJournalRepository } from './infrastructure/pg/pg-journal.repository.js';
