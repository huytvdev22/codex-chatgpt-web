import { logFunctionInput } from "../debug-logger";
import {
  type OpenAIToolCall,
  type ParseDiagnostics,
  type TranslationResult,
  type DetectedToolCall,
  type IToolCallDetector,
  type BaseToolCallDetector,
  PatchToolCallDetector,
  JsonToolCallDetector,
  XmlToolCallDetector,
  BashCommandDetector,
  stripOuterCodeFence,
  normalizeToolName,
  balanceJsonBraces,
  cleanJsonPayload,
  normalizePatchEnvelope,
  generateToolCallId,
  sanitizeCodexPatchContent,
} from "./detectors";

import { maskArgumentsForLog, maskToolCallsForLog } from "./log-masker";

// Re-export toàn bộ hợp đồng và helper để duy trì 100% tương thích ngược
export type {
  OpenAIToolCall,
  ParseDiagnostics,
  TranslationResult,
  DetectedToolCall,
  IToolCallDetector,
  BaseToolCallDetector,
};

export {
  PatchToolCallDetector,
  JsonToolCallDetector,
  XmlToolCallDetector,
  BashCommandDetector,
  stripOuterCodeFence,
  normalizeToolName,
  balanceJsonBraces,
  cleanJsonPayload,
  normalizePatchEnvelope,
  generateToolCallId,
  sanitizeCodexPatchContent,
  maskArgumentsForLog,
  maskToolCallsForLog,
};

/**
 * Trích xuất các khối nhận thức (Thinking & Narrative) từ phản hồi của M365
 */
export function extractCognitiveBlocks(rawText: string): {
  thinking?: string;
  narrative?: string;
  cleanedText: string;
} {
  logFunctionInput("translation:output-translator", "extractCognitiveBlocks", { rawTextLength: rawText.length });
  let thinking: string | undefined;

  // 0. Gọt bỏ thẻ bọc envelope <m365Response>...</m365Response>
  const textWithoutEnvelope = rawText.replace(/<\s*\/?\s*m365[\\_]*response\s*>/gi, "");

  // 1. Trích xuất nội dung thẻ <thought>...</thought> hoặc <thinking>...</thinking>
  const thoughtMatch = textWithoutEnvelope.match(/<\s*(?:thought|thinking)\s*>([\s\S]*?)<\s*\/(?:thought|thinking)\s*>/i);
  if (thoughtMatch) {
    const rawThought = thoughtMatch[1].trim();
    if (rawThought.length > 0) {
      thinking = rawThought;
    }
  }

  // 2. Làm sạch chuỗi bằng cách xóa bỏ khối thought
  const textWithoutThought = textWithoutEnvelope.replace(/<\s*(?:thought|thinking)\s*>[\s\S]*?<\s*\/(?:thought|thinking)\s*>/gi, "").trim();

  // 3. Trích xuất narrative (lời dẫn dắt bước đi) bằng cách loại bỏ các khối tool call và patch
  let textWithoutTools = textWithoutThought
    .replace(/(?:<|\b)\s*(?:custom[\\_]*)?tool[\\_]*call(?:\s+[^>]*)?>[\s\S]*?(?:<\s*\/|\/\s*)(?:custom[\\_]*)?tool[\\_]*call\s*>/gi, "")
    .replace(/(?:\\?\*){2,3}\s*Begin Patch[\s\S]*?(?:\\?\*){2,3}\s*End Patch(?:\s*\\?\*+)?/gi, "");

  // Nếu có khối code block bash mang tính thực thi
  textWithoutTools = textWithoutTools.replace(/```(?:bash|sh|zsh|shell)?\s*\n[\s\S]*?```/gi, "");

  const narrativeCandidate = textWithoutTools.trim();
  const narrative = narrativeCandidate.length > 0 ? narrativeCandidate : undefined;

  return {
    thinking,
    narrative,
    cleanedText: textWithoutThought,
  };
}

/**
 * Lớp chính Output Translator điều phối toàn bộ quá trình nhận diện và dịch
 * Tuân thủ Dependency Inversion (DIP) & Single Responsibility (SRP)
 */
export class M365OutputTranslator {
  private readonly detectors: IToolCallDetector[] = [];

  /**
   * Khởi tạo bộ biên dịch đầu ra của M365 Copilot với danh sách các detector đăng ký.
   */
  constructor(customDetectors?: IToolCallDetector[]) {
    logFunctionInput("translation:output-translator", "constructor", { customDetectors });
    if (customDetectors && customDetectors.length > 0) {
      this.detectors = [...customDetectors].sort((a, b) => a.priority - b.priority);
    } else {
      // Đăng ký theo thứ tự ưu tiên chuẩn: Patch (0) -> JSON (1) -> XML (2) -> Bash (3)
      this.detectors = [
        new PatchToolCallDetector(),
        new JsonToolCallDetector(),
        new XmlToolCallDetector(),
        new BashCommandDetector(),
      ].sort((a, b) => a.priority - b.priority);
    }
  }

  /**
   * Phương thức dịch phản hồi thô từ M365 thành TranslationResult
   * Hỗ trợ dịch đồng thời nhiều tool call (Parallel / Multi-tool calls)
   * và bóc tách các khối nhận thức (Thinking & Narrative)
   */
  translate(rawResponse: string): TranslationResult {
    logFunctionInput("translation:output-translator", "translate", { rawResponse });
    const rawPreview = rawResponse.length > 2000
      ? `${rawResponse.slice(0, 1000)}\n... [TRUNCATED ${rawResponse.length - 1500} chars for privacy] ...\n${rawResponse.slice(-500)}`
      : rawResponse;
    console.log("\n[M365 RAW RESPONSE]");
    console.log(rawPreview);

    // Tự động lột bỏ lớp vỏ code block ngoài cùng (````markdown ... ```` hoặc ```...```)
    // để các detector phát hiện công cụ bên trong, hoặc trả về văn bản sạch cho Final Answer
    const unwrappedResponse = stripOuterCodeFence(rawResponse);
    const cognitive = extractCognitiveBlocks(unwrappedResponse);
    const textForDetectors = cognitive.cleanedText;

    // Nếu phản hồi chứa thẻ <proposed_plan>, đây là bản kế hoạch hoàn chỉnh cho Codex UI duyệt (Final Answer)
    if (/<\s*proposed[\\_]*plan\s*>[\s\S]*?<\s*\/proposed[\\_]*plan\s*>/i.test(unwrappedResponse)) {
      return {
        type: "final_answer",
        content: cognitive.cleanedText || unwrappedResponse.trim(),
        thinking: cognitive.thinking,
        rawResponse,
        parseDiagnostics: {
          terminalReason: "proposed_plan",
          warningMessage: "Phản hồi chứa bản kế hoạch <proposed_plan>. Trả về Final Answer cho người dùng/Codex duyệt kế hoạch.",
        },
      };
    }

    // Duyệt qua các detector theo thứ tự ưu tiên (kiểm tra trên textForDetectors trước, dự phòng unwrappedResponse / rawResponse)
    for (const detector of this.detectors) {
      const detected = detector.detect(textForDetectors) || detector.detect(unwrappedResponse) || detector.detect(rawResponse);
      if (detected) {
        const callsList = Array.isArray(detected) ? detected : [detected];
        const toolCalls: OpenAIToolCall[] = callsList.map(item => ({
          id: generateToolCallId(),
          type: "function",
          function: {
            name: item.name,
            arguments: JSON.stringify(item.arguments),
          },
        }));

        console.log("\n[TRANSLATED TOOL CALL]");
        console.log(JSON.stringify({
          tool_calls: maskToolCallsForLog(toolCalls),
          ...(cognitive.thinking ? { thinking: cognitive.thinking } : {}),
          ...(cognitive.narrative ? { narrative: cognitive.narrative } : {}),
        }, null, 2));

        return {
          type: "tool_call",
          tool_calls: toolCalls,
          thinking: cognitive.thinking,
          narrative: cognitive.narrative,
          rawResponse,
          parseDiagnostics: {
            terminalReason: "tool_calls_emitted",
            warningMessage: `Phát hiện ${toolCalls.length} tool call hợp lệ: ${toolCalls.map(t => t.function.name).join(", ")}.`,
          },
        };
      }
    }

    // Nếu không khớp với bất kỳ tool call nào, đây là Final Answer
    const trimmedAnswer = cognitive.cleanedText || unwrappedResponse.trim();

    // Kiểm tra chẩn đoán: Có chứa dấu hiệu nghi vấn tool call mà không parse được hay không?
    const hasSuspiciousXml = /<\s*tool[\\_]*call\s*>/i.test(textForDetectors);
    const hasUnclosedXml = hasSuspiciousXml && !/<\s*\/tool[\\_]*call\s*>/i.test(textForDetectors);
    const hasSuspiciousJson = /"action"\s*:\s*"tool_call"|"name"\s*:\s*"(?:read_file|write_file|apply_patch|exec_command|run_command|write_stdin|view_image|request_user_input|create_goal|update_goal|get_goal)"/i.test(textForDetectors);
    const hasSuspiciousPatch = /(?:\\?\*){3}\s*Begin Patch/i.test(textForDetectors);

    let diagnosticWarning = "";
    if (hasUnclosedXml) {
      diagnosticWarning = "Phát hiện thẻ <tool_call> chưa được đóng hoàn chỉnh từ M365 (thiếu </tool_call>). Codex dừng do nhận kết quả là văn bản thường.";
    } else if (hasSuspiciousXml) {
      diagnosticWarning = "Phát hiện khối <tool_call> hoàn chỉnh nhưng parse JSON thất bại. Codex bị dừng xử lý và chuyển sang Final Answer vì lý do này.";
    } else if (hasSuspiciousPatch) {
      diagnosticWarning = "Phát hiện khối *** Begin Patch nhưng khối patch chưa đóng hoặc bị lỗi cấu trúc. Codex dừng xử lý.";
    } else if (hasSuspiciousJson) {
      diagnosticWarning = "Phát hiện chuỗi JSON có thuộc tính tool_call nhưng không trích xuất được tham số hợp lệ.";
    }

    return {
      type: "final_answer",
      content: trimmedAnswer,
      thinking: cognitive.thinking,
      rawResponse,
      ...(diagnosticWarning
        ? {
          parseDiagnostics: {
            suspiciousToolDetected: true,
            warningMessage: diagnosticWarning,
          },
        }
        : {
          parseDiagnostics: {
            terminalReason: "model_final_answer",
            warningMessage: "M365 Copilot hoàn tất câu trả lời dạng văn bản kết luận (Final Answer).",
          },
        }),
    };
  }

  /**
   * Helper chuyển đổi kết quả sang payload OpenAI tool_calls trực tiếp
   */
  toOpenAIPayload(rawResponse: string): { tool_calls: OpenAIToolCall[] } | { content: string } {
    logFunctionInput("translation:output-translator", "toOpenAIPayload", { rawResponse });
    const result = this.translate(rawResponse);
    if (result.type === "tool_call") {
      return { tool_calls: result.tool_calls };
    }
    return { content: result.content };
  }
}
