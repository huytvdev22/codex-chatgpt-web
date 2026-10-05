import { logFunctionInput } from "../../debug-logger";
import type { IToolCallDetector, DetectedToolCall } from "./types";
import { BashCommandTranslator } from "../bash-translator";

/**
 * Bộ phát hiện Bash Command (Ưu tiên C)
 * Hỗ trợ một hoặc nhiều lệnh shell (cat file1 file2, cat file1\ncat file2, git status, v.v.)
 */
export class BashCommandDetector implements IToolCallDetector {
  readonly priority = 3;
  readonly name = "BashCommandDetector";

    /**
   * Khởi tạo bộ phát hiện lệnh bash với instance biên dịch lệnh tương ứng.
   */
constructor(private readonly translator = new BashCommandTranslator()) {
    logFunctionInput("translation:detectors:bash-detector", "constructor", { translator }); }

    /**
   * Quét và phát hiện các khối lệnh bash thực thi trong câu trả lời của mô hình.
   */
detect(rawResponse: string): DetectedToolCall[] | DetectedToolCall | null {
    logFunctionInput("translation:detectors:bash-detector", "detect", { rawResponse });
    const all = this.translator.translateAll(rawResponse);
    if (all.length === 0) return null;
    return all.length === 1 ? all[0] : all;
  }
}
