import assert from "node:assert";
import {
  availableM365ModelRoutes,
  isM365ModelSlug,
  resolveM365CapabilityMode,
  requireM365ModelRoute,
} from "../src/m365-models.ts";
import {
  M365_CAPABILITY_SPECS,
  M365CapabilityPicker,
} from "../src/adapters/m365-copilot/browser/capability-picker.ts";

console.log("=============================================================");
console.log("🚀 KIỂM THỬ TÍCH HỢP CAPABILITY PICKER & M365 MODEL CATALOG");
console.log("=============================================================");

// 1. Kiểm tra Model Catalog M365
console.log("\n[Test 1] Kiểm tra danh mục Model Route M365...");
const routes = availableM365ModelRoutes();
console.log("Danh sách route M365:", routes.map(r => `${r.slug} (${r.capabilityMode})`));

assert(routes.length >= 2, "Danh sách routes phải có ít nhất 2 model");
assert(isM365ModelSlug("m365-copilot/auto"), "m365-copilot/auto phải là M365 slug");
assert(isM365ModelSlug("m365-copilot/gpt-5.6-think"), "m365-copilot/gpt-5.6-think phải là M365 slug");
assert(isM365ModelSlug("m365-copilot/gpt-5.6-quick"), "m365-copilot/gpt-5.6-quick phải là M365 slug");
assert(isM365ModelSlug("m365-copilot/think"), "m365-copilot/think phải là M365 slug");
assert(isM365ModelSlug("m365-copilot/quick"), "m365-copilot/quick phải là M365 slug");
assert(isM365ModelSlug("m365-copilot/gpt-5.6"), "m365-copilot/gpt-5.6 phải là M365 slug");
assert(isM365ModelSlug("m365-copilot"), "m365-copilot phải là M365 slug");
console.log("✅ [Test 1 PASSED] Model routes được khai báo đầy đủ!");

// 2. Kiểm tra hàm resolveM365CapabilityMode
console.log("\n[Test 2] Kiểm tra hàm resolveM365CapabilityMode...");
assert.strictEqual(resolveM365CapabilityMode("m365-copilot/auto"), "auto");
assert.strictEqual(resolveM365CapabilityMode("m365-copilot/gpt-5.6-think"), "gpt-5.6-think");
assert.strictEqual(resolveM365CapabilityMode("m365-copilot/gpt-5.6-quick"), "gpt-5.6-quick");
assert.strictEqual(resolveM365CapabilityMode("m365-copilot/think"), "think");
assert.strictEqual(resolveM365CapabilityMode("m365-copilot/quick"), "quick");
// Backward compatibility / alias slugs
assert.strictEqual(resolveM365CapabilityMode("m365-copilot/gpt-5.6"), "gpt-5.6-quick");
assert.strictEqual(resolveM365CapabilityMode("m365-copilot/gpt-5.6", "high"), "gpt-5.6-think");
assert.strictEqual(resolveM365CapabilityMode("m365-copilot", "high"), "think");
assert.strictEqual(resolveM365CapabilityMode("m365-copilot/gpt-5"), "gpt-5.6-think");
assert.strictEqual(resolveM365CapabilityMode("m365-copilot/fast"), "quick");
assert.strictEqual(resolveM365CapabilityMode("m365-copilot/gpt-5.6-reasoning"), "gpt-5.6-think");
assert.strictEqual(resolveM365CapabilityMode("m365-copilot/gpt-5.6-instant"), "gpt-5.6-quick");
assert.strictEqual(resolveM365CapabilityMode("m365-custom-think"), "think");
assert.strictEqual(resolveM365CapabilityMode(undefined), "auto");
console.log("✅ [Test 2 PASSED] Phân giải Capability Mode chính xác!");

// 3. Kiểm tra Đặc tả Capability Specs
console.log("\n[Test 3] Kiểm tra M365_CAPABILITY_SPECS...");
const modes = ["auto", "quick", "think", "gpt-5.6-think", "gpt-5.6-quick"];
for (const mode of modes) {
  const spec = M365_CAPABILITY_SPECS[mode];
  assert(spec, `Thiếu spec cho mode: ${mode}`);
  assert(spec.label, `Thiếu label cho mode: ${mode}`);
  assert(spec.iconTestId, `Thiếu iconTestId cho mode: ${mode}`);
  console.log(` - [${mode}]: label="${spec.label}", icon="${spec.iconTestId}", isSubmenu=${Boolean(spec.isSubmenu)}`);
}
console.log("✅ [Test 3 PASSED] Toàn bộ đặc tả icon và label hợp lệ!");

// 4. Kiểm tra giả lập tương tác DOM với Mock Page và DOM HTML thực tế
console.log("\n[Test 4] Kiểm tra logic M365CapabilityPicker với Mock Page DOM thực tế...");

class MockElement {
  constructor(tag, attrs = {}, text = "") {
    this.tagName = tag.toUpperCase();
    this.attributes = { ...attrs };
    this.textContent = text;
    this.children = [];
    this.parentElement = null;
    this.listeners = {};
  }

  getAttribute(name) {
    return this.attributes[name] ?? null;
  }

  setAttribute(name, val) {
    this.attributes[name] = String(val);
  }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  closest(selector) {
    let cur = this;
    while (cur) {
      if (cur.matches(selector)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  matches(selector) {
    const parts = selector.split(",").map(s => s.trim());
    return parts.some(sel => {
      if (sel.startsWith(".")) {
        const cls = sel.slice(1);
        const curCls = this.attributes["class"] || "";
        return curCls.split(/\s+/).includes(cls);
      }
      if (sel.startsWith("#")) {
        return this.attributes["id"] === sel.slice(1);
      }
      if (sel.includes("[role=")) {
        const m = sel.match(/\[role="?([^"\]]+)"?\]/);
        return m && this.attributes["role"] === m[1];
      }
      if (sel.includes("[data-testid=")) {
        const m = sel.match(/\[data-testid="?([^"\]]+)"?\]/);
        return m && this.attributes["data-testid"] === m[1];
      }
      return this.tagName.toLowerCase() === sel.toLowerCase();
    });
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const results = [];
    const walk = (node) => {
      for (const ch of node.children) {
        if (ch.matches(selector)) {
          results.push(ch);
        }
        walk(ch);
      }
    };
    walk(this);
    return results;
  }

  addEventListener(type, fn) {
    if (!this.listeners[type]) this.listeners[type] = [];
    this.listeners[type].push(fn);
  }

  dispatchEvent(evt) {
    const fns = this.listeners[evt.type] || [];
    for (const fn of fns) fn(evt);
    return true;
  }

  focus() {}
  click() {
    this.dispatchEvent({ type: "click" });
  }
}

class MockPage {
  constructor(initialHtmlState) {
    this.state = initialHtmlState;
    this.keyboard = {
      press: async (key) => {
        if (key === "Escape") {
          this.state.escaped = true;
        }
      }
    };
  }

  async evaluate(fn, arg) {
    // Khởi tạo global mock document trước khi chạy evaluate
    const origDoc = globalThis.document;
    const origPointerEvent = globalThis.PointerEvent;
    const origMouseEvent = globalThis.MouseEvent;
    const origKeyboardEvent = globalThis.KeyboardEvent;

    globalThis.PointerEvent = class { constructor(t) { this.type = t; } };
    globalThis.MouseEvent = class { constructor(t) { this.type = t; } };
    globalThis.KeyboardEvent = class { constructor(t) { this.type = t; } };

    globalThis.document = this.state.buildDocument();

    try {
      return await fn(arg);
    } finally {
      globalThis.document = origDoc;
      globalThis.PointerEvent = origPointerEvent;
      globalThis.MouseEvent = origMouseEvent;
      globalThis.KeyboardEvent = origKeyboardEvent;
    }
  }

  async waitForSelector(sel, opts) {
    return true;
  }
}

// Thiết lập cây DOM mẫu dựa trên HTML thực tế của M365 Copilot do người dùng cung cấp
function createM365MockEnvironment(activeMode = "auto") {
  let selected = activeMode;
  let primaryMenuOpen = false;
  let submenuOpen = false;

  return {
    get selected() { return selected; },
    buildDocument() {
      const doc = new MockElement("body");

      // 1. Nút Switcher ngoài giao diện
      const switcherText = selected === "auto" ? "Auto"
        : selected === "quick" ? "Quick response"
        : selected === "think" ? "Think deeper"
        : selected === "gpt-5.6-quick" ? "GPT-5.6 Sol Quick response"
        : "GPT-5.6 Sol Think deeper";

      const switcherBtn = new MockElement("button", {
        type: "button",
        role: "button",
        tabindex: "0",
        "aria-haspopup": "menu",
        id: "gptModeSwitcher",
        class: "fui-Button r1f29ykk fai-bebop",
        "aria-label": `${switcherText}, Model Selector`,
      }, switcherText);

      switcherBtn.addEventListener("click", () => {
        primaryMenuOpen = true;
      });
      doc.appendChild(switcherBtn);

      // 2. Menu Popover Cấp 1
      const popover1 = new MockElement("div", {
        role: "presentation",
        class: "fui-MenuPopover fai-bebop",
      });
      const menuList1 = new MockElement("div", {
        role: "menu",
        class: "fui-MenuList fai-bebop",
      });
      popover1.appendChild(menuList1);

      // Item Auto
      const itemAuto = new MockElement("div", {
        role: "menuitem",
        "data-testid": "gptSubMenuModelTrigger-Magic",
        "aria-checked": selected === "auto" ? "true" : "false",
        class: "fui-MenuItem",
      }, "Auto Decides how long to think");
      const iconAuto = new MockElement("svg", { "data-testid": "checkmark-Magic", class: "fui-Icon" });
      itemAuto.appendChild(iconAuto);
      itemAuto.addEventListener("click", () => { selected = "auto"; });
      menuList1.appendChild(itemAuto);

      // Item Quick
      const itemQuick = new MockElement("div", {
        role: "menuitem",
        "data-testid": "gptSubMenuModelTrigger-Chat",
        "aria-checked": selected === "quick" ? "true" : "false",
        class: "fui-MenuItem",
      }, "Quick response Answers right away");
      const iconQuick = new MockElement("svg", { "data-testid": "checkmark-Chat", class: "fui-Icon" });
      itemQuick.appendChild(iconQuick);
      itemQuick.addEventListener("click", () => { selected = "quick"; });
      menuList1.appendChild(itemQuick);

      // Item Think
      const itemThink = new MockElement("div", {
        role: "menuitem",
        "data-testid": "gptSubMenuModelTrigger-Reasoning",
        "aria-checked": selected === "think" ? "true" : "false",
        class: "fui-MenuItem",
      }, "Think deeper Think longer for better answers");
      const iconThink = new MockElement("svg", { "data-testid": "checkmark-Reasoning", class: "fui-Icon" });
      itemThink.appendChild(iconThink);
      itemThink.addEventListener("click", () => { selected = "think"; });
      menuList1.appendChild(itemThink);

      // Item Submenu Trigger GPT (OpenAI)
      const itemOpenAI = new MockElement("div", {
        role: "menuitem",
        "aria-haspopup": "menu",
        "data-testid": "gptSubMenuModelTrigger-OpenAI",
        class: "fui-MenuItem",
      }, "GPT OpenAI");
      const iconOpenAI = new MockElement("svg", { "data-testid": "checkmark-OpenAI", class: "fui-Icon" });
      itemOpenAI.appendChild(iconOpenAI);
      itemOpenAI.addEventListener("click", () => {
        submenuOpen = true;
      });
      menuList1.appendChild(itemOpenAI);
      doc.appendChild(popover1);

      // 3. Menu Popover Cấp 2 (Submenu OpenAI)
      const popover2 = new MockElement("div", {
        role: "presentation",
        class: "fui-MenuPopover fai-bebop",
      });
      const menuList2 = new MockElement("div", {
        role: "menu",
        class: "fui-MenuList fai-bebop",
      });
      popover2.appendChild(menuList2);

      // Submenu Item: GPT-5.6 Sol Quick response
      const subItemQuick = new MockElement("div", {
        role: "menuitem",
        "data-testid": "gptSubMenuModelTrigger-OpenAI",
        "aria-checked": selected === "gpt-5.6-quick" ? "true" : "false",
        class: "fui-MenuItem",
      }, "GPT-5.6 Sol Quick response");
      const iconSubQuick = new MockElement("svg", { "data-testid": "checkmark-Gpt_5_6_Chat", class: "fui-Icon" });
      subItemQuick.appendChild(iconSubQuick);
      subItemQuick.addEventListener("click", () => { selected = "gpt-5.6-quick"; });
      menuList2.appendChild(subItemQuick);

      // Submenu Item: GPT-5.6 Sol Think deeper
      const subItemThink = new MockElement("div", {
        role: "menuitem",
        "data-testid": "gptSubMenuModelTrigger-OpenAI",
        "aria-checked": selected === "gpt-5.6-think" ? "true" : "false",
        class: "fui-MenuItem",
      }, "GPT-5.6 Sol Think deeper");
      const iconSubThink = new MockElement("svg", { "data-testid": "checkmark-Gpt_5_6_Reasoning", class: "fui-Icon" });
      subItemThink.appendChild(iconSubThink);
      subItemThink.addEventListener("click", () => { selected = "gpt-5.6-think"; });
      menuList2.appendChild(subItemThink);

      doc.appendChild(popover2);

      return doc;
    }
  };
}

const picker = new M365CapabilityPicker();

// Test chọn từng mode:
const testCases = [
  { target: "quick", expected: "quick", desc: "Chuyển sang Quick response" },
  { target: "think", expected: "think", desc: "Chuyển sang Think deeper" },
  { target: "gpt-5.6-quick", expected: "gpt-5.6-quick", desc: "Chuyển sang GPT-5.6 Sol Quick response (Submenu)" },
  { target: "gpt-5.6-think", expected: "gpt-5.6-think", desc: "Chuyển sang GPT-5.6 Sol Think deeper (Submenu)" },
  { target: "auto", expected: "auto", desc: "Chuyển trở lại Auto" },
];

for (const tc of testCases) {
  const env = createM365MockEnvironment("auto");
  const mockPage = new MockPage(env);
  const success = await picker.ensureMode(mockPage, tc.target);
  assert(success, `ensureMode thất bại cho ${tc.desc}`);
  assert.strictEqual(env.selected, tc.expected, `Trạng thái chọn không khớp cho ${tc.desc}`);
  console.log(`✅ [DOM Test] ${tc.desc} -> Thành công!`);
}

// Test trường hợp mode đã active sẵn ngoài nút switcher
{
  const env = createM365MockEnvironment("think");
  const mockPage = new MockPage(env);
  const success = await picker.ensureMode(mockPage, "think");
  assert(success, "Mode đã active phải trả về true ngay lập tức");
  console.log(`✅ [DOM Test] Phát hiện mode đã active trên #gptModeSwitcher -> Thành công!`);
}

console.log("\n=============================================================");
console.log("🎉 TẤT CẢ CÁC BƯỚC KIỂM THỬ ĐÃ THÀNH CÔNG RỰC RỠ!");
console.log("=============================================================");
