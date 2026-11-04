/**
 * Script kiểm tra toàn bộ Selector của Google AI Studio (aistudio.google.com).
 * 
 * CÁCH DÙNG:
 * 1. Mở trang: https://aistudio.google.com/u/0/prompts/new_chat?model=gemini-flash-latest
 * 2. Mở Chrome DevTools (F12) -> Chọn tab "Console"
 * 3. Copy toàn bộ nội dung script này và Paste vào Console rồi nhấn Enter.
 * 4. Gọi các hàm helper có sẵn để test:
 *    - inspectSelectors()            : Kiểm tra và in bảng trạng thái các phần tử DOM.
 *    - setThinkingLevel('Low')       : Chuyển Thinking Level sang Low ('Low' | 'Medium' | 'High').
 *    - sendTestPrompt('Hello test')  : Điền prompt, bấm gửi và theo dõi phản hồi stream.
 *    - readLatestResponse()          : Đọc nội dung phản hồi cuối cùng (loại bỏ thinking).
 */

(function initGoogleAIStudioInspector() {
  console.clear();
  console.log("%c🚀 GOOGLE AI STUDIO SELECTOR INSPECTOR INITIALIZED", "color: #4285f4; font-size: 14px; font-weight: bold;");

  const SELECTORS = {
    // 1. Ô nhập liệu (Composer)
    composer: 'textarea[aria-label="Start typing a prompt"], textarea[aria-label="Type something or tab to choose an example prompt"], textarea[aria-label="Enter a prompt"]',
    composerFallback: 'ms-prompt-editor textarea, div.buttons-row textarea',

    // 2. Nút Run / Send
    runButton: 'ms-run-button button:not(.stoppable)',
    runButtonGeneric: 'ms-run-button button',

    // 3. Nút Stop khi đang sinh
    stopButton: 'ms-run-button button.stoppable, ms-run-button button',

    // 4. Output phản hồi
    chatTurn: 'ms-chat-turn',
    textChunk: 'ms-chat-turn .model-prompt-container ms-text-chunk',
    thoughtChunk: 'ms-thought-chunk',
    outputChunkFallback: 'div.output-chunk',

    // 5. Cài đặt Thinking level
    thinkingSettingWrapper: 'ms-thinking-level-setting',
    thinkingSelectTrigger: 'ms-thinking-level-setting mat-select[aria-label="Thinking Level"], ms-thinking-level-setting mat-select',
    thinkingCurrentValue: 'ms-thinking-level-setting .mat-mdc-select-value-text .mat-mdc-select-min-line, ms-thinking-level-setting .mat-mdc-select-value',
    thinkingSelectPanel: 'div.mat-mdc-select-panel[aria-label="Thinking Level"], div[role="listbox"][aria-label="Thinking Level"]',
    thinkingOptionItem: 'mat-option',
  };

  /**
   * Helper tìm phần tử DOM
   */
  function _q(selector) {
    return document.querySelector(selector);
  }

  function _qa(selector) {
    return Array.from(document.querySelectorAll(selector));
  }

  /**
   * 1. Kiểm tra và in bảng trạng thái tất cả các phần tử DOM
   */
  window.inspectSelectors = function () {
    console.group("%c📋 KẾT QUẢ KIỂM TRA DOM SELECTORS", "color: #34a853; font-weight: bold;");

    const composerEl = _q(SELECTORS.composer) || _q(SELECTORS.composerFallback);
    const runBtnEl = _q(SELECTORS.runButton);
    const genericRunBtn = _q(SELECTORS.runButtonGeneric);
    const isRunning = genericRunBtn && (genericRunBtn.classList.contains('stoppable') || (genericRunBtn.textContent || '').includes('Stop'));
    
    const thinkingWrapperEl = _q(SELECTORS.thinkingSettingWrapper);
    const thinkingSelectEl = _q(SELECTORS.thinkingSelectTrigger);
    const thinkingValEl = _q(SELECTORS.thinkingCurrentValue);
    const currentThinkingText = thinkingValEl ? thinkingValEl.textContent.trim() : "(Không tìm thấy)";

    const turns = _qa(SELECTORS.chatTurn);
    const textChunks = _qa(SELECTORS.textChunk);
    const cleanChunks = textChunks.filter(el => !el.closest(SELECTORS.thoughtChunk));

    const report = [
      {
        "Thành phần": "1. Ô nhập liệu (Composer)",
        "Trạng thái": composerEl ? "✅ Tìm thấy" : "❌ Không thấy",
        "Chi tiết": composerEl ? `<textarea> (value: "${composerEl.value.slice(0, 30)}...")` : "Cần kiểm tra lại aria-label",
      },
      {
        "Thành phần": "2. Nút Run (Gửi)",
        "Trạng thái": runBtnEl ? "✅ Sẵn sàng gửi" : (isRunning ? "⏳ Đang chạy (Stop)" : "⚠️ Không sẵn sàng"),
        "Chi tiết": genericRunBtn ? `Text: "${genericRunBtn.textContent.trim()}", disabled: ${genericRunBtn.disabled}` : "Không tìm thấy nút Run",
      },
      {
        "Thành phần": "3. Nút Stop",
        "Trạng thái": isRunning ? "🛑 Đang hiển thị Stop" : "⚪ Không ở trạng thái sinh",
        "Chi tiết": isRunning ? "Model đang sinh kết quả..." : "Bình thường",
      },
      {
        "Thành phần": "4. Thinking Level Component",
        "Trạng thái": thinkingWrapperEl ? "✅ Tìm thấy" : "❌ Không thấy",
        "Chi tiết": thinkingSelectEl ? `Mức hiện tại: %c${currentThinkingText}` : "Không tìm thấy mat-select",
      },
      {
        "Thành phần": "5. Chat Turns & Response Chunks",
        "Trạng thái": turns.length > 0 ? `✅ ${turns.length} turns` : "⚪ Chưa có turn nào",
        "Chi tiết": `Tổng text chunks: ${textChunks.length} (Sạch không thought: ${cleanChunks.length})`,
      },
    ];

    console.table(report);
    console.log(`%c👉 Mức Thinking hiện tại: %c${currentThinkingText}`, "font-weight: bold;", "color: #ea4335; font-weight: bold; font-size: 13px;");
    console.groupEnd();

    return {
      composerEl,
      runBtnEl,
      genericRunBtn,
      thinkingSelectEl,
      currentThinkingText,
      turns,
      cleanChunks,
    };
  };

  /**
   * 2. Tự động chuyển đổi mức độ Thinking ('Low' | 'Medium' | 'High')
   */
  window.setThinkingLevel = async function (targetLevel = "Medium") {
    const validLevels = ["Low", "Medium", "High"];
    const matchedLevel = validLevels.find(l => l.toLowerCase() === targetLevel.toLowerCase());
    if (!matchedLevel) {
      console.error(`❌ Mức thinking không hợp lệ: "${targetLevel}". Hãy chọn: Low | Medium | High`);
      return false;
    }

    console.log(`%c🔄 Đang thử đổi Thinking Level sang: %c${matchedLevel}...`, "color: #fbbc05;", "font-weight: bold;");

    const selectEl = _q(SELECTORS.thinkingSelectTrigger);
    if (!selectEl) {
      console.error("❌ Không tìm thấy mat-select của Thinking Level!");
      return false;
    }

    // 1. Click mở dropdown
    const triggerEl = selectEl.querySelector('.mat-mdc-select-trigger') || selectEl;
    triggerEl.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    triggerEl.click();

    // 2. Chờ popup panel xuất hiện
    await new Promise(r => setTimeout(r, 400));
    const panel = _q(SELECTORS.thinkingSelectPanel);
    if (!panel) {
      console.error("❌ Panel danh sách options của Thinking Level chưa mở!");
      return false;
    }

    // 3. Tìm option tương ứng
    const options = Array.from(panel.querySelectorAll(SELECTORS.thinkingOptionItem));
    let targetOption = null;

    for (const opt of options) {
      const text = (opt.textContent || "").trim();
      if (text.toLowerCase().includes(matchedLevel.toLowerCase())) {
        targetOption = opt;
        break;
      }
    }

    if (!targetOption) {
      console.error(`❌ Không tìm thấy option cho mức "${matchedLevel}" trong danh sách:`, options.map(o => o.textContent.trim()));
      return false;
    }

    // 4. Click chọn option
    targetOption.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    targetOption.click();

    await new Promise(r => setTimeout(r, 300));

    // 5. Xác nhận lại giá trị sau khi chọn
    const valEl = _q(SELECTORS.thinkingCurrentValue);
    const newText = valEl ? valEl.textContent.trim() : "";
    if (newText.toLowerCase().includes(matchedLevel.toLowerCase())) {
      console.log(`%c✅ Đã chuyển Thinking Level thành công sang: %c${newText}`, "color: #34a853;", "font-weight: bold;");
      return true;
    } else {
      console.warn(`⚠️ Giá trị sau khi click là "${newText}", chưa khớp hoàn toàn với "${matchedLevel}"`);
      return false;
    }
  };

  /**
   * 3. Nhập prompt và click Run để test gửi tin nhắn
   */
  window.sendTestPrompt = async function (promptText = "Viết 1 đoạn code Python tính số Fibonacci ngắn gọn.") {
    console.log(`%c📝 Đang chuẩn bị gửi prompt: "${promptText}"`, "color: #4285f4;");

    const composer = _q(SELECTORS.composer) || _q(SELECTORS.composerFallback);
    if (!composer) {
      console.error("❌ Không tìm thấy ô nhập prompt!");
      return;
    }

    // Focus & set value
    composer.focus();
    composer.value = promptText;
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    composer.dispatchEvent(new Event('change', { bubbles: true }));

    await new Promise(r => setTimeout(r, 300));

    const runBtn = _q(SELECTORS.runButton);
    if (!runBtn) {
      console.warn("⚠️ Không thấy nút Run enabled, thử kích hoạt bằng phím tắt Ctrl+Enter trên ô nhập...");
      composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', ctrlKey: true, bubbles: true }));
    } else {
      console.log("👉 Đang click nút Run...");
      runBtn.click();
    }

    console.log("%c⏳ Đang chờ model sinh câu trả lời...", "color: #fbbc05;");

    // Theo dõi trạng thái
    let pollCount = 0;
    const interval = setInterval(() => {
      pollCount++;
      const genericRunBtn = _q(SELECTORS.runButtonGeneric);
      const isGenerating = genericRunBtn && (genericRunBtn.classList.contains('stoppable') || (genericRunBtn.textContent || '').includes('Stop'));

      if (isGenerating) {
        console.log(`[Đang sinh...] Đã trôi qua ${pollCount * 500}ms - Nút Stop đang hoạt động`);
      } else if (pollCount > 2) {
        clearInterval(interval);
        console.log("%c✅ Model đã hoàn thành phản hồi!", "color: #34a853; font-weight: bold; font-size: 13px;");
        window.readLatestResponse();
      }

      if (pollCount > 60) { // 30s timeout
        clearInterval(interval);
        console.warn("⚠️ Hết thời gian chờ theo dõi.");
      }
    }, 500);
  };

  /**
   * 4. Đọc phản hồi mới nhất (loại bỏ thinking)
   */
  window.readLatestResponse = function () {
    const textChunks = _qa(SELECTORS.textChunk);
    const cleanChunks = textChunks.filter(el => !el.closest(SELECTORS.thoughtChunk));

    if (cleanChunks.length === 0) {
      console.log("Chưa có phản hồi hoặc không tìm thấy chunk nào.");
      return "";
    }

    const fullText = cleanChunks.map(c => c.textContent).join("\n").trim();
    console.group("%c💬 NỘI DUNG PHẢN HỒI (ĐÃ LỌC THOUGHT CHUNKS):", "color: #1a73e8; font-weight: bold;");
    console.log(fullText);
    console.groupEnd();
    return fullText;
  };

  // Tự động chạy kiểm tra lần đầu
  window.inspectSelectors();

  console.log("%c✨ GỢI Ý CÁC LỆNH TEST BẠN CÓ THỂ GÕ VÀO CONSOLE:", "font-weight: bold; color: #7952b3;");
  console.log("1️⃣ inspectSelectors()               -> Kiểm tra toàn bộ element");
  console.log("2️⃣ setThinkingLevel('Low')          -> Đổi mức thinking sang Low");
  console.log("3️⃣ setThinkingLevel('High')         -> Đổi mức thinking sang High");
  console.log("4️⃣ sendTestPrompt('Chào bạn!')      -> Gửi thử prompt và theo dõi");
  console.log("5️⃣ readLatestResponse()             -> Đọc câu trả lời hiện tại");
})();

