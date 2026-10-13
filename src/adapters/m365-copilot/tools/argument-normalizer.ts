import {
  ToolArgumentNormalizer,
  DEFAULT_TOOL_NAME_ALIASES,
  type NormalizedToolArguments,
} from "../../base-web/tools";

export const TOOL_NAME_ALIASES = DEFAULT_TOOL_NAME_ALIASES;
export type { NormalizedToolArguments };

export function normalizeM365ToolName(name: string): string {
  return ToolArgumentNormalizer.normalizeToolName(name);
}

export function normalizeM365ToolArguments(
  name: string,
  argumentsValue: Record<string, unknown> | string
): NormalizedToolArguments {
  return ToolArgumentNormalizer.normalizeToolArguments(name, argumentsValue);
}
