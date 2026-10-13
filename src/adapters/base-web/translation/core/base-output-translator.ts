import type { IOutputTranslator } from "../contracts/output-translator.interface";
import type { IToolCallDetector } from "../contracts/tool-call-detector.interface";
import type { OpenAIToolCall } from "../dto/openai-tool-call.dto";
import type { TranslationResult } from "../dto/translation-result.dto";
import {
  XmlToolCallDetector,
  stripOuterCodeFence,
  generateToolCallId,
} from "../detectors";
import { CognitiveBlockExtractor } from "./cognitive-block-extractor";
import { maskToolCallsForLog } from "./log-masker";

/**
 * Lớp điều phối đầu ra trừu tượng hóa cho toàn bộ Web Chat Adapters
 * Áp dụng Chain of Responsibility & Template Method Pattern để nhận diện tool calls và final answers
 */
export class BaseOutputTranslator implements IOutputTranslator {
  protected readonly detectors: IToolCallDetector[] = [];

  constructor(customDetectors?: IToolCallDetector[]) {
    if (customDetectors && customDetectors.length > 0) {
      this.detectors = [...customDetectors].sort((a, b) => a.priority - b.priority);
    } else {
      // Mặc định nhận diện explicit XML tool envelope
      this.detectors = [
        new XmlToolCallDetector(),
      ].sort((a, b) => a.priority - b.priority);
    }
  }

  /**
   * Đăng ký thêm một ToolCallDetector vào chuỗi xử lý
   */
  public registerDetector(detector: IToolCallDetector): this {
    this.detectors.push(detector);
    this.detectors.sort((a, b) => a.priority - b.priority);
    return this;
  }

  /**
   * Phương thức dịch phản hồi thô thành TranslationResult
   * Hỗ trợ dịch đồng thời nhiều tool call (Parallel / Multi-tool calls)
   * và bóc tách các khối nhận thức (Thinking & Narrative)
   */
  public translate(rawResponse: string): TranslationResult {
    const rawPreview = rawResponse.length > 2000
      ? `${rawResponse.slice(0, 1000)}\n... [TRUNCATED ${rawResponse.length - 1500} chars for privacy] ...\n${rawResponse.slice(-500)}`
      : rawResponse;
    console.log("\n[WEB RAW RESPONSE]");
    console.log(rawPreview);

    // Tự động lột bỏ lớp vỏ code block ngoài cùng (````markdown ... ```` hoặc ```...```)
    const unwrappedResponse = stripOuterCodeFence(rawResponse);
    const cognitive = CognitiveBlockExtractor.extract(unwrappedResponse);
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
      diagnosticWarning = "Phát hiện thẻ <tool_call> chưa được đóng hoàn chỉnh từ model (thiếu </tool_call>). Codex dừng do nhận kết quả là văn bản thường.";
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
            warningMessage: "Hoàn tất câu trả lời dạng văn bản kết luận (Final Answer).",
          },
        }),
    };
  }

  /**
   * Helper chuyển đổi kết quả sang payload OpenAI tool_calls trực tiếp
   */
  public toOpenAIPayload(rawResponse: string): { tool_calls: OpenAIToolCall[] } | { content: string } {
    const result = this.translate(rawResponse);
    if (result.type === "tool_call") {
      return { tool_calls: result.tool_calls };
    }
    return { content: result.content };
  }
}
