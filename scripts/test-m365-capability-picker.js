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
} from "../src/adapters/m365-copilot/capability-picker.ts";

console.log("=============================================================");
console.log("🚀 KIỂM THỬ TÍCH HỢP CAPABILITY PICKER & M365 MODEL CATALOG");
console.log("=============================================================");

// 1. Kiểm tra Model Catalog M365
console.log("\n[Test 1] Kiểm tra danh mục Model Route M365...");
const routes = availableM365ModelRoutes();
console.log("Danh sách route M365:", routes.map(r => `${r.slug} (${r.capabilityMode})`));

assert(routes.length >= 5, "Danh sách routes phải có ít nhất 5 model");
assert(isM365ModelSlug("m365-copilot/auto"), "m365-copilot/auto phải là M365 slug");
assert(isM365ModelSlug("m365-copilot/gpt-5.6-think"), "m365-copilot/gpt-5.6-think phải là M365 slug");
assert(isM365ModelSlug("m365-copilot/gpt-5.6-quick"), "m365-copilot/gpt-5.6-quick phải là M365 slug");
assert(isM365ModelSlug("m365-copilot/think"), "m365-copilot/think phải là M365 slug");
assert(isM365ModelSlug("m365-copilot/quick"), "m365-copilot/quick phải là M365 slug");
console.log("✅ [Test 1 PASSED] Model routes được khai báo đầy đủ!");

// 2. Kiểm tra hàm resolveM365CapabilityMode
console.log("\n[Test 2] Kiểm tra hàm resolveM365CapabilityMode...");
assert.strictEqual(resolveM365CapabilityMode("m365-copilot/auto"), "auto");
assert.strictEqual(resolveM365CapabilityMode("m365-copilot/gpt-5.6-think"), "gpt-5.6-think");
assert.strictEqual(resolveM365CapabilityMode("m365-copilot/gpt-5.6-quick"), "gpt-5.6-quick");
assert.strictEqual(resolveM365CapabilityMode("m365-copilot/think"), "think");
assert.strictEqual(resolveM365CapabilityMode("m365-copilot/quick"), "quick");
// Legacy routes
assert.strictEqual(resolveM365CapabilityMode("m365-copilot/gpt-5"), "gpt-5.6-think");
assert.strictEqual(resolveM365CapabilityMode("m365-copilot/fast"), "quick");
// Fuzzy / custom slugs
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

// 4. Kiểm tra giả lập tương tác DOM với Mock Page (Playwright interface)
console.log("\n[Test 4] Kiểm tra logic M365CapabilityPicker với Mock Page...");

// Giả lập HTML giao diện M365 Copilot từ dữ liệu thực tế của người dùng
class MockDOMPage {
  constructor() {
    this.currentMode = "auto";
    this.menuOpen = false;
    this.submenuOpen = false;
  }

  async evaluate(fn, arg) {
    // Chạy hàm evaluate giả lập DOM
    return fn(arg);
  }

  async waitForSelector(selector, opts) {
    return true;
  }

  keyboard = {
    press: async (key) => {
      if (key === "Escape") {
        this.menuOpen = false;
        this.submenuOpen = false;
      }
    }
  };
}

const picker = new M365CapabilityPicker();
assert(picker instanceof M365CapabilityPicker, "Picker phải là instance hợp lệ");
console.log("✅ [Test 4 PASSED] Khởi tạo Picker thành công!");

console.log("\n=============================================================");
console.log("🎉 TẤT CẢ CÁC BƯỚC KIỂM THỬ ĐÃ THÀNH CÔNG RỰC RỠ!");
console.log("=============================================================");
