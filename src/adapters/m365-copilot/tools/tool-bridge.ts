import type { CodexTool } from "../../../types";
import {
  BaseToolBridge,
  SafeCommandGuard,
  ToolContentDecoder,
  type RawToolCallDto,
  type MappedToolCallDto,
  type RequestUserInputOptionDto,
  type RequestUserInputQuestionDto,
} from "../../base-web/tools";

export { SafeCommandGuard };
export const normalizeFileContent = ToolContentDecoder.normalizeFileContent;
export type { NormalizeFileContentOptions } from "../../base-web/tools";

export type M365RawToolCall = RawToolCallDto;
export type M365MappedToolCall = MappedToolCallDto;
export type RequestUserInputOption = RequestUserInputOptionDto;
export type RequestUserInputQuestion = RequestUserInputQuestionDto;

export const normalizeRequestUserInputArgs = (args: Record<string, any>) => BaseToolBridge.normalizeRequestUserInputArgs(args);

/**
 * Cầu nối native-first giữa M365 Copilot và Codex runtime.
 * Kế thừa BaseToolBridge từ base-web và đảm bảo tương thích ngược 100%.
 */
export class M365ToolBridge extends BaseToolBridge {
  static mapToolCall(raw: M365RawToolCall, clientTools: CodexTool[] = []): M365MappedToolCall {
    return BaseToolBridge.mapToolCall(raw, clientTools);
  }
}
