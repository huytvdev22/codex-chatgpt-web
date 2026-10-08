import { describe, test, expect } from "bun:test";
import { autoHealHtmlMangledTags, sanitizeCodexPatchContent } from "../src/adapters/m365-copilot/translation/toolcall-detector";
import { normalizeFileContent } from "../src/adapters/m365-copilot/tools/tool-bridge";

describe("M365 HTML & Tag Mangling Auto-Healing Tests", () => {
  test("1. Phục hồi thẻ script bị biến dạng thành js/storage.jsscript> và js/app.jsatch", () => {
    const rawPatch = `*** Begin Patch
*** Update File: index.html
@@
-  <meta name="description" content="Ứng dụng quản lý công việc">
-  <meta name="viewport" content="width=device-width, initial-scale=1.0">
   <meta name="description" content="Ứng dụng quản lý công việc cá nhân">
@@
-  js/storage.jsscript>
-  js/app.jsatch
+  js/storage.jsscript>
+  js/app.jsscript>
 </body>
*** End Patch`;

    const healed = autoHealHtmlMangledTags(rawPatch);
    expect(healed).toContain('-  <script src="js/storage.js"></script>');
    expect(healed).toContain('-  <script src="js/app.js"></script>');
    expect(healed).toContain('+  <script src="js/storage.js"></script>');
    expect(healed).toContain('+  <script src="js/app.js"></script>');
    expect(healed).not.toContain("jsscript>");
    expect(healed).not.toContain("jsatch");
  });

  test("2. sanitizeCodexPatchContent tự động chữa lành các thẻ script và stylesheet trong patch", () => {
    const mangled = `*** Begin Patch
*** Update File: index.html
@@
-  styles.csslink>
+  styles.csslink>
-  js/storage.jsscript>
+  js/storage.jsscript>
*** End Patch`;

    const sanitized = sanitizeCodexPatchContent(mangled);
    expect(sanitized).toContain('-  <link rel="stylesheet" href="styles.css">');
    expect(sanitized).toContain('+  <link rel="stylesheet" href="styles.css">');
    expect(sanitized).toContain('-  <script src="js/storage.js"></script>');
    expect(sanitized).toContain('+  <script src="js/storage.js"></script>');
  });

  test("3. normalizeFileContent tự động phục hồi mã nguồn HTML khi dùng write_file", () => {
    const mangledHtml = `<!DOCTYPE html>
<html>
<head>
  styles.csslink>
</head>
<body>
  <h1>App</h1>
  js/storage.jsscript>
  js/app.jsatch
</body>
</html>`;

    const normalized = normalizeFileContent(mangledHtml, { targetPath: "index.html" });
    expect(normalized).toContain('<link rel="stylesheet" href="styles.css">');
    expect(normalized).toContain('<script src="js/storage.js"></script>');
    expect(normalized).toContain('<script src="js/app.js"></script>');
  });
});
