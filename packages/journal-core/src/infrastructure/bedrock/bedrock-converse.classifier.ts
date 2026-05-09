// Bedrock Converse classifier: calls Claude Sonnet via toolConfig to produce structured journal lines.

import {
  AccessDeniedException,
  BedrockRuntimeClient,
  ConverseCommand,
  ResourceNotFoundException,
  ServiceUnavailableException,
  ThrottlingException,
} from '@aws-sdk/client-bedrock-runtime';
import { BedrockUnavailableError, RateLimitError } from '@ym/shared-errors';
import { z } from 'zod';
import type { TransactionClassifier, ClassifyInput, ClassifyResult } from '../../application/ports/transaction-classifier.port.js';
import { createJournalLine } from '../../domain/journal-line.value-object.js';

const MODEL_ID = process.env.BEDROCK_MODEL_ID ?? 'global.anthropic.claude-sonnet-4-6';
const REQUEST_TIMEOUT_MS = 20_000;

const client = new BedrockRuntimeClient({
  requestHandler: { requestTimeout: REQUEST_TIMEOUT_MS } as Record<string, unknown>,
});

const ClassifyOutputSchema = z.object({
  lines: z
    .array(
      z.object({
        lineNo: z.number().int().positive(),
        accountCode: z.string().min(1),
        debit: z.number().min(0),
        credit: z.number().min(0),
      }),
    )
    .min(2),
  confidence: z.number().min(0).max(1),
});

const SYSTEM_PROMPT = `You are a Korean K-IFRS accounting expert. Classify the given transaction into double-entry journal lines. Use standard Korean account codes (e.g. 1002 for 보통예금, 5301 for 임차료, 5401 for 통신비). The sum of all debit amounts must equal the sum of all credit amounts.`;

export class BedrockConverseClassifier implements TransactionClassifier {
  async classify(input: ClassifyInput): Promise<ClassifyResult> {
    const userMessage = `Classify this transaction:
Date: ${input.date}
Amount: ${input.amount} KRW
Counterparty: ${input.counterparty}
Memo: ${input.memo}`;

    let response;
    try {
      response = await client.send(
        new ConverseCommand({
          modelId: MODEL_ID,
          system: [{ text: SYSTEM_PROMPT }],
          messages: [{ role: 'user', content: [{ text: userMessage }] }],
          toolConfig: {
            tools: [
              {
                toolSpec: {
                  name: 'record_journal_entry',
                  description: 'Record the classified double-entry journal lines with confidence score.',
                  inputSchema: {
                    json: {
                      type: 'object',
                      required: ['lines', 'confidence'],
                      properties: {
                        lines: {
                          type: 'array',
                          minItems: 2,
                          items: {
                            type: 'object',
                            required: ['lineNo', 'accountCode', 'debit', 'credit'],
                            properties: {
                              lineNo: { type: 'integer', minimum: 1 },
                              accountCode: { type: 'string' },
                              debit: { type: 'number', minimum: 0 },
                              credit: { type: 'number', minimum: 0 },
                            },
                          },
                        },
                        confidence: { type: 'number', minimum: 0, maximum: 1 },
                      },
                    },
                  },
                },
              },
            ],
            toolChoice: { tool: { name: 'record_journal_entry' } },
          },
        }),
      );
    } catch (err) {
      if (
        err instanceof ResourceNotFoundException ||
        err instanceof AccessDeniedException ||
        err instanceof ServiceUnavailableException
      ) {
        throw new BedrockUnavailableError(err instanceof Error ? err.message : undefined);
      }
      if (err instanceof ThrottlingException) {
        throw new RateLimitError(
          'BEDROCK_THROTTLED',
          'AI classification is temporarily rate limited. Try again.',
          err instanceof Error ? err.message : undefined,
        );
      }
      throw err;
    }

    const toolUseBlock = response.output?.message?.content?.find((b) => b.toolUse?.name === 'record_journal_entry');
    if (!toolUseBlock?.toolUse?.input) throw new Error('Bedrock did not return a tool call result');

    const parsed = ClassifyOutputSchema.parse(toolUseBlock.toolUse.input);
    const lines = parsed.lines.map((l) =>
      createJournalLine({ lineNo: l.lineNo, accountCode: l.accountCode, debit: l.debit, credit: l.credit }),
    );

    const usage = response.usage;

    return {
      lines,
      confidence: parsed.confidence,
      modelId: MODEL_ID,
      ...(usage?.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage?.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
    };
  }
}
