import type { CodexTool } from "../../../../types";
import type { RawToolCallDto } from "../dto/raw-tool-call.dto";
import type { MappedToolCallDto } from "../dto/mapped-tool-call.dto";

export interface IToolBridge {
  mapToolCall(raw: RawToolCallDto, clientTools?: CodexTool[]): MappedToolCallDto;
}
