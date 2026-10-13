export interface ToolRepetitionPolicy {
  maxToolIterations: number;
  maxIdenticalToolCalls: number;
  maxIdenticalReadToolCalls: number;
  maxIdenticalWriteToolCalls: number;
  guardTtlMs: number;
  readOnlyTools: ReadonlySet<string>;
}
