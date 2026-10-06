import { existsSync } from "node:fs";
import { logFunctionInput } from "../../debug-logger";
import { emitStructuredEvent } from "../../../../observability/emitter";
import { logDebugPipelineStation } from "../../../../observability/debug-logger";
import { M365MarkdownBuffer, type M365MarkdownBlock } from "../../translation/semantic-detector";
import { FastPathStreamBuffer } from "../../temp-chat/fastPathScraper";
import {
  connectCdpSurface,
  notifyCdpTurnStart,
  notifyCdpTurnHeartbeat,
  notifyCdpTurnEnd,
  resolveDescriptorPath,
  withTimeout,
} from "../cdp";
import type { PageDriver, M365BrowserRunOptions } from "../contracts/page-driver";
import { globalBrowserTurnMutex } from "./turn-mutex";

/**
 * Điều phối toàn bộ vòng đời thực thi một lượt hội thoại (Turn Orchestration)
 * hoàn toàn độc lập với chi tiết cài đặt của từng trang web cụ thể.
 */
export async function executeTurnWithDriver(
  driver: PageDriver,
  promptText: string,
  options: M365BrowserRunOptions
): Promise<string> {
  logFunctionInput("browser:engine:orchestrator", "executeTurnWithDriver", {
    driverId: driver.id,
    promptLength: promptText.length,
    options,
  });

  const descriptorPath = resolveDescriptorPath(options.descriptorPath);
  if (!existsSync(descriptorPath)) {
    throw new Error(
      `Không tìm thấy runtime descriptor của Launcher tại: ${descriptorPath}. Vui lòng đảm bảo ứng dụng Codex Desktop đang mở!`
    );
  }

  // Khóa tuần tự giữa các cửa sổ VS Code để chống tranh chấp DOM
  const releaseTurnLock = await globalBrowserTurnMutex.acquire(options.signal);

  let targetSurfaceId: string | undefined = undefined;
  if (options.traceId) {
    try {
      const lease = await notifyCdpTurnStart(
        descriptorPath,
        options.traceId,
        {
          conversationKey: options.conversationKey,
          connectorIdentity: driver.id,
        },
        options.signal
      );
      if (lease?.surfaceId) {
        targetSurfaceId = lease.surfaceId;
        console.log(`[orchestrator] Đã nhận được Tab Surface riêng từ Launcher: ${targetSurfaceId}`);
      }
    } catch {
      // Bỏ qua lỗi start nếu launcher chưa phản hồi
    }
  }

  const connection = await connectCdpSurface(descriptorPath, targetSurfaceId, options.signal);
  const { browser, page } = connection;
  let finalStatus: "completed" | "failed" | "aborted" = "failed";
  const startTime = Date.now();

  emitStructuredEvent({
    level: "info",
    event: "m365.provider.started",
    traceContext: options.traceContext,
    safeDetails: {
      provider: driver.id,
      modelSlug: options.modelSlug,
      isNewConversation: Boolean(options.isNewConversation),
      injectedPromptPreview: promptText,
      rawPrompt: promptText,
      promptBytes: Buffer.byteLength(promptText, "utf8"),
    },
    diagnosticDetails: {
      promptBytes: Buffer.byteLength(promptText, "utf8"),
    },
  });

  // [DEBUG PIPELINE] STEP 2: Bridge Server ➔ Web Browser (RAW INJECTED PROMPT)
  logDebugPipelineStation(2, `BRIDGE SERVER ➔ ${driver.name.toUpperCase()} (RAW INJECTED PROMPT)`, promptText);

  try {
    // 1. Chuẩn bị trang web qua PageDriver
    await driver.ensureReady(page, options);

    if (driver.prepareNewChat) {
      await driver.prepareNewChat(page, options);
    }

    if (driver.ensureModelMode && options.modelSlug) {
      await driver.ensureModelMode(page, options.modelSlug);
    }

    await driver.waitForIdle(page, options.signal);

    // 2. Chụp ảnh baseline và gửi prompt
    const beforeState = await driver.captureBaseline(page);
    await driver.submitPrompt(page, promptText);

    // 3. Vòng lặp quan sát tiến trình sinh phản hồi (Streaming Observation Loop)
    const markdownBuffer = new M365MarkdownBuffer();
    const fastPathBuffer = new FastPathStreamBuffer();
    let fastPathActive = false;
    let lastFastPathText = "";
    let seenGenerating = false;
    let hasSeenGenerating = false;
    let completedCandidateAt: number | null = null;
    const stableCompletionMs = 500;
    let attempts = 0;
    let stableCycles = 0;
    let lastTextChangeAt = Date.now();
    let lastBlocks: M365MarkdownBlock[] = [];
    let lastStatus: any = null;
    const maxAttempts = 2400; // 2400 * 250ms = 600 giây tối đa
    const pollIntervalMs = 250;

    while (attempts < maxAttempts) {
      if (options.signal?.aborted) {
        await driver.abortGeneration(page).catch(() => {});
        throw new DOMException(`${driver.name} turn aborted by client`, "AbortError");
      }

      if (options.shouldStop?.() && lastStatus && !lastStatus.isGenerating) {
        console.log(`[orchestrator] [early-stop-safe] options.shouldStop triggered và ${driver.name} đã dừng sinh.`);
        break;
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));
      attempts++;

      const status = await driver.scrapeTurnProgress(page, beforeState);

      if (status.isGenerating) {
        hasSeenGenerating = true;
        seenGenerating = true;
        completedCandidateAt = null;
      } else if (hasSeenGenerating) {
        if (completedCandidateAt === null) {
          completedCandidateAt = Date.now();
        }
      }

      if (status.detectedWebError) {
        throw new Error(`[${driver.name} Web Error] ${status.detectedWebError}`);
      }

      if (status.isGenerating) {
        seenGenerating = true;
      }

      if (attempts === 80 && !seenGenerating && status.blocks.length === 0) {
        console.warn(
          `[orchestrator] [warning] Sau 20s vẫn chưa nhận được phản hồi từ ${driver.name} (có thể nút Gửi chưa được kích hoạt hoặc mạng chậm).`
        );
      }

      if (options.traceId && attempts % 40 === 0) {
        notifyCdpTurnHeartbeat(descriptorPath, options.traceId, options.signal).catch(() => {});
      }

      if (driver.periodicAction) {
        await driver.periodicAction(page, attempts);
      }

      // Stream các khối đã hoàn thành
      if (typeof status.fastPathRawText === "string" && status.fastPathRawText.length > 0) {
        fastPathActive = true;
        lastFastPathText = status.fastPathRawText;
        const delta = fastPathBuffer.observe(lastFastPathText);
        if (delta.length > 0) {
          options.onChunk(delta);
          lastTextChangeAt = Date.now();
          stableCycles = 0;
        } else {
          stableCycles++;
        }
      } else if (!fastPathActive && status.blocks && status.blocks.length > 0) {
        lastBlocks = status.blocks as M365MarkdownBlock[];
        const delta = markdownBuffer.observe(lastBlocks);
        if (delta.length > 0) {
          options.onChunk(delta);
          lastTextChangeAt = Date.now();
          stableCycles = 0;
        } else {
          stableCycles++;
        }
      }

      if (attempts % 16 === 0) {
        const elapsedSec = Math.round((attempts * pollIntervalMs) / 1000);
        const currentChars = fastPathActive
          ? lastFastPathText.length
          : lastBlocks.reduce((acc, b) => acc + b.text.length, 0);
        const stableSec = Math.round((Date.now() - lastTextChangeAt) / 1000);
        const combinedTextSoFar = fastPathActive
          ? lastFastPathText
          : lastBlocks.map((b) => b.text).join(" ");
        const unclosedToolCall =
          /(?:<|\b)\s*tool\\\\?_call\s*>/i.test(combinedTextSoFar) &&
          !/(?:<\s*\/|\/\s*)tool\\\\?_call\s*>/i.test(combinedTextSoFar);
        const unclosedPatch =
          /(?:\\?\*){3}\s*Begin Patch/i.test(combinedTextSoFar) &&
          !/(?:\\?\*){3}\s*End Patch/i.test(combinedTextSoFar);
        const unclosedPlan =
          /<\s*proposed[\\_]*plan\s*>/i.test(combinedTextSoFar) &&
          !/<\s*\/proposed[\\_]*plan\s*>/i.test(combinedTextSoFar);

        const statusSummary = status.isGenerating
          ? `${driver.name} đang sinh văn bản (${elapsedSec}s, ${currentChars} ký tự)...`
          : status.hasContent
          ? `${driver.name} tạm dừng sinh, đang chờ ổn định (${stableSec}s, ${currentChars} ký tự)...`
          : `Đang chờ ${driver.name} bắt đầu phản hồi (${elapsedSec}s)...`;

        emitStructuredEvent({
          level: "info",
          event: "m365.provider.progress",
          traceContext: options.traceContext,
          safeDetails: {
            elapsedSeconds: elapsedSec,
            isGenerating: status.isGenerating,
            outputChars: currentChars,
            stableSeconds: stableSec,
            hasUnclosedToolCall: unclosedToolCall,
            hasUnclosedPatch: unclosedPatch,
            hasUnclosedPlan: unclosedPlan,
            statusSummary,
            domStatus: status.isGenerating ? "generating" : status.hasContent ? "settling" : "idle",
          },
        });
      }

      // Điều kiện kết thúc & kiểm tra độ ổn định
      const combinedText = fastPathActive ? lastFastPathText : lastBlocks.map((b) => b.text).join(" ");
      const hasUnclosedToolCall =
        /(?:<|\b)\s*tool\\?_call\s*>/i.test(combinedText) &&
        !/(?:<\s*\/|\/\s*)tool\\?_call\s*>/i.test(combinedText);
      const hasUnclosedPatch =
        /(?:\\?\*){2,3}\s*Begin Patch/i.test(combinedText) &&
        !/(?:\\?\*){2,3}\s*End Patch/i.test(combinedText);
      const hasUnclosedPlan =
        /<\s*proposed[\\_]*plan\s*>/i.test(combinedText) &&
        !/<\s*\/proposed[\\_]*plan\s*>/i.test(combinedText);
      const toolCallFullyClosed = /(?:<\s*\/|\/\s*)tool\\?_call\s*>/i.test(combinedText);
      const planFullyClosed = /<\s*\/proposed[\\_]*plan\s*>/i.test(combinedText);
      const patchFullyClosed =
        /(?:\\?\*){2,3}\s*End Patch/i.test(combinedText) ||
        /<\s*\/\s*custom_tool_call\s*>/i.test(combinedText);
      const m365ResponseFullyClosed = /(?:<\s*\/|\/\s*)m365[\\_]*response\s*>/i.test(combinedText);

      const isLongResponse = combinedText.length > 2000;
      const minStableTime = isLongResponse ? 6000 : 3000;
      const minStableCycles = isLongResponse ? 24 : 8;

      const hasFullyClosedMarker =
        toolCallFullyClosed || planFullyClosed || patchFullyClosed || m365ResponseFullyClosed;
      const hasAnyUnclosedMarker = hasUnclosedToolCall || hasUnclosedPatch || hasUnclosedPlan;
      const timeSinceChange = Date.now() - lastTextChangeAt;
      const deadlockTimeoutMs = hasAnyUnclosedMarker ? 30_000 : 8_000;
      const deadlockCycles = hasAnyUnclosedMarker ? 120 : 32;

      const isStopDismissedStable =
        hasSeenGenerating &&
        !status.isGenerating &&
        completedCandidateAt !== null &&
        Date.now() - completedCandidateAt >= stableCompletionMs;
      const isState1Idle =
        Boolean((status as any).isInputActionsIdle) && !status.isGenerating && stableCycles >= 1;

      const isSettled =
        !status.isGenerating &&
        (isState1Idle ||
          isStopDismissedStable ||
          (hasFullyClosedMarker && stableCycles >= 1) ||
          (!hasAnyUnclosedMarker &&
            (stableCycles >= minStableCycles || timeSinceChange >= minStableTime)) ||
          timeSinceChange >= deadlockTimeoutMs ||
          stableCycles >= deadlockCycles);

      if (status.hasContent && !status.isGenerating && isSettled) {
        console.log(
          `[orchestrator] [completed] attempts=${attempts} durationMs=${
            attempts * pollIntervalMs
          } hasSeenGenerating=${hasSeenGenerating} isState1Idle=${Boolean(
            (status as any).isInputActionsIdle
          )} timeSinceCandidate=${
            completedCandidateAt ? Date.now() - completedCandidateAt : 0
          }ms toolCallClosed=${toolCallFullyClosed} patchClosed=${patchFullyClosed} planClosed=${planFullyClosed} timeSinceChange=${timeSinceChange}ms fastPath=${fastPathActive}`
        );
        break;
      }

      lastStatus = status;
      if (attempts >= maxAttempts) {
        const timeSinceLastChange = Date.now() - lastTextChangeAt;
        const isActivelyGenerating = status.isGenerating || timeSinceLastChange < 30_000;
        if (isActivelyGenerating && attempts < maxAttempts + 2400) {
          if (attempts % 40 === 0) {
            console.log(
              `[orchestrator] [extended-liveness] Model vẫn đang tích cực sinh phản hồi (${Math.round(
                timeSinceLastChange / 1000
              )}s kể từ token gần nhất), tiếp tục chờ...`
            );
          }
        } else {
          break;
        }
      }
    }

    const timedOut =
      attempts >= maxAttempts && (lastStatus?.isGenerating || Date.now() - lastTextChangeAt >= 30_000);
    if (timedOut) {
      console.warn(
        `[orchestrator] [timeout] Đã đạt ngưỡng tối đa ${Math.round(
          (attempts * pollIntervalMs) / 1000
        )}s chờ ${driver.name} kết thúc.`
      );
    }

    // Kết thúc lượt sinh: Flush toàn bộ các khối còn lại
    let fullMarkdown = "";
    let finalDelta = "";
    if (fastPathActive || (fastPathBuffer.getText() && fastPathBuffer.getText().length > 0)) {
      const res = fastPathBuffer.finish(lastFastPathText || fastPathBuffer.getText());
      fullMarkdown = res.markdown || fastPathBuffer.getText();
      finalDelta = res.delta;
    }
    if (!fullMarkdown || !fullMarkdown.trim()) {
      const res = markdownBuffer.finish(lastBlocks);
      if (res.markdown && res.markdown.trim()) {
        fullMarkdown = res.markdown;
        finalDelta = res.delta;
      }
    }
    if (!fullMarkdown || !fullMarkdown.trim()) {
      fullMarkdown =
        fastPathBuffer.getText() ||
        lastFastPathText ||
        (lastBlocks || []).map((b) => b.text).join("\n") ||
        "";
      if (fullMarkdown && !finalDelta) {
        finalDelta = fullMarkdown;
      }
    }

    // Auto-Healing cho patch
    if (
      /(?:\\?\*){2,3}\s*Begin Patch/i.test(fullMarkdown) &&
      !/(?:\\?\*){2,3}\s*End Patch/i.test(fullMarkdown)
    ) {
      console.warn(
        `[orchestrator] [auto-heal] Phát hiện patch chưa đóng do model dừng sinh giữa chừng. Tự động bổ sung *** End Patch ***.`
      );
      const closingPatch = "\n*** End Patch ***\n";
      fullMarkdown = `${fullMarkdown.trimEnd()}${closingPatch}`;
      finalDelta = `${finalDelta}${closingPatch}`;
      if (
        /<custom_tool_call(?:\s+name=["']apply_patch["'])?[^>]*>/i.test(fullMarkdown) &&
        !/<\/custom_tool_call>/i.test(fullMarkdown)
      ) {
        const closingTag = "</custom_tool_call>\n";
        fullMarkdown = `${fullMarkdown}${closingTag}`;
        finalDelta = `${finalDelta}${closingTag}`;
      }
    }

    if (!fullMarkdown || !fullMarkdown.trim()) {
      throw new Error(
        `[${driver.name} Format Error] Không nhận được bất kỳ nội dung phản hồi nào từ ${driver.name}. Vui lòng kiểm tra kết nối mạng hoặc thử lại.`
      );
    }

    if (finalDelta.length > 0 && !options.shouldStop?.()) {
      options.onChunk(finalDelta);
    }

    finalStatus = "completed";
    emitStructuredEvent({
      level: timedOut ? "warning" : "info",
      event: "m365.provider.finished",
      traceContext: options.traceContext,
      safeDetails: {
        provider: driver.id,
        status: finalStatus,
        durationMs: Date.now() - startTime,
        outputChars: fullMarkdown.length,
        responsePreview: fullMarkdown,
        rawResponse: fullMarkdown,
        timedOut,
        terminalReason: timedOut ? "polling_timeout" : "completed_settled",
        terminalExplanation: timedOut
          ? `Hết thời gian chờ tối đa nhưng ${driver.name} chưa đóng khối phản hồi hoàn toàn.`
          : `${driver.name} đã hoàn tất và văn bản đã ổn định.`,
      },
      diagnosticDetails: {
        outputBytes: Buffer.byteLength(fullMarkdown, "utf8"),
      },
    });
    console.log(
      `[orchestrator] [completed] totalChars=${fullMarkdown.length} finalStatus=${finalStatus} timedOut=${timedOut}`
    );

    // [DEBUG PIPELINE] STEP 3: Web Browser ➔ Bridge Server (RAW RESPONSE SCRAPING)
    logDebugPipelineStation(3, `${driver.name.toUpperCase()} ➔ BRIDGE SERVER (RAW RESPONSE SCRAPING)`, fullMarkdown);

    // Ghi nhớ URL thread sau khi turn hoàn tất nếu không phải temporary chat
    if (!options.forceTemporaryChat && options.conversationKey && driver.recordConversationThread) {
      const currentUrl = page.url();
      driver.recordConversationThread(options.conversationKey, currentUrl);
    }

    // Nếu là phiên trò chuyện tạm thời: Tự động dọn dẹp sạch thread trên M365 để không để lại rác trên sidebar Chats
    if (options.forceTemporaryChat && driver.cleanupEphemeralThread) {
      await driver.cleanupEphemeralThread(page);
    }

    return fullMarkdown;
  } catch (err) {
    if (options.signal?.aborted) {
      finalStatus = "aborted";
      emitStructuredEvent({
        level: "warning",
        event: "m365.provider.finished",
        traceContext: options.traceContext,
        safeDetails: {
          provider: driver.id,
          status: finalStatus,
          durationMs: Date.now() - startTime,
          outputChars: 0,
        },
      });
      console.log(`[orchestrator] [aborted] turn aborted by client`);
    } else {
      finalStatus = "failed";
      emitStructuredEvent({
        level: "error",
        event: "m365.provider.finished",
        traceContext: options.traceContext,
        safeDetails: {
          provider: driver.id,
          status: finalStatus,
          durationMs: Date.now() - startTime,
          outputChars: 0,
        },
        diagnosticDetails: {
          errorMessage: err instanceof Error ? err.message : String(err),
        },
      });
      console.error(`[orchestrator] [error]`, err);
    }
    throw err;
  } finally {
    try {
      if (options.traceId) {
        const isTemporary = Boolean(options.forceTemporaryChat);
        const notifyPromise = notifyCdpTurnEnd(
          descriptorPath,
          options.traceId,
          finalStatus,
          { retain: !isTemporary },
          undefined
        ).catch(() => {});
        await withTimeout(notifyPromise, 2000, undefined);
      }
      console.log(`[orchestrator] [cleanup] closing browser connection (timeout 3000ms)...`);
      await withTimeout(browser.close().catch(() => {}), 3000, undefined);
      console.log(`[orchestrator] [cleanup] browser closed`);
    } finally {
      releaseTurnLock();
    }
  }
}
