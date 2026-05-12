// Generic Tool contract for Bedrock Converse tool_use loops.

export interface JsonSchema {
  readonly type: 'object';
  readonly required?: ReadonlyArray<string>;
  readonly properties?: Record<string, unknown>;
  readonly additionalProperties?: boolean;
}

export interface Tool<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  execute(input: TInput, ctx: ToolContext): Promise<TOutput>;
}

export interface ToolContext {
  readonly tenantId: string;
  readonly userId: string;
  readonly cognitoSub: string;
}
