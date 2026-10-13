import type { PromptSectionMetrics } from "./prompt-metrics.dto";
import type { PromptAuditData } from "./prompt-audit.dto";

export interface PromptCompileResult {
  finalPrompt: string;
  metrics: PromptSectionMetrics;
  audit: PromptAuditData;
  collaborationMode: "default" | "plan";
  isPlanMode: boolean;
  isImplementingPlan: boolean;
}
