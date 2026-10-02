const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  OBS_PREFIX_V1,
  filterSafeDetailsForExport,
} = require("../electron/observability-policy.cjs");
const {
  tryParseStructuredEnvelope,
  dispatchStructuredLog,
} = require("../electron/runtime-supervisor.cjs");
const {
  createLogger,
  exportSanitizedLogs,
} = require("../electron/logging.cjs");

test("TC-15: nonce comparison handles length/type mismatch safely without throwing", () => {
  const expectedNonce = "a".repeat(32);

  // 1. Nonce sai độ dài (ngắn hơn hoặc dài hơn)
  const shortNoncePayload = `${OBS_PREFIX_V1}${JSON.stringify({
    version: 1,
    nonce: "a".repeat(16),
    level: "info",
    event: "test.event",
    detail: { message: "short nonce" },
  })}`;
  assert.equal(tryParseStructuredEnvelope(shortNoncePayload, expectedNonce), null);

  const longNoncePayload = `${OBS_PREFIX_V1}${JSON.stringify({
    version: 1,
    nonce: "a".repeat(64),
    level: "info",
    event: "test.event",
    detail: { message: "long nonce" },
  })}`;
  assert.equal(tryParseStructuredEnvelope(longNoncePayload, expectedNonce), null);

  // 2. Nonce không phải string (null, number, object, array, boolean)
  for (const invalidNonce of [null, undefined, 12345, true, {}, []]) {
    const invalidPayload = `${OBS_PREFIX_V1}${JSON.stringify({
      version: 1,
      nonce: invalidNonce,
      level: "info",
      event: "test.event",
      detail: { message: "invalid nonce type" },
    })}`;
    assert.doesNotThrow(() => {
      const parsed = tryParseStructuredEnvelope(invalidPayload, expectedNonce);
      assert.equal(parsed, null);
    });
  }

  // 3. Expected nonce rỗng hoặc null
  const validPayload = `${OBS_PREFIX_V1}${JSON.stringify({
    version: 1,
    nonce: expectedNonce,
    level: "info",
    event: "test.event",
    detail: { message: "valid nonce" },
  })}`;
  assert.equal(tryParseStructuredEnvelope(validPayload, ""), null);
  assert.equal(tryParseStructuredEnvelope(validPayload, null), null);

  // 4. Đúng nonce và đúng format -> parse thành công
  const parsed = tryParseStructuredEnvelope(validPayload, expectedNonce);
  assert.notEqual(parsed, null);
  assert.equal(parsed.event, "test.event");
  assert.equal(parsed.detail.message, "valid nonce");
});

test("TC-16: warning log level maps strictly to logger.warn, never logger.warning", () => {
  const calls = [];
  const mockLogger = {
    warn(event, detail) {
      calls.push({ method: "warn", event, detail });
    },
    info(event, detail) {
      calls.push({ method: "info", event, detail });
    },
    error(event, detail) {
      calls.push({ method: "error", event, detail });
    },
    debug(event, detail) {
      calls.push({ method: "debug", event, detail });
    },
    // Không có method 'warning' - nếu dispatch gọi động logger['warning']() sẽ throw TypeError!
  };

  const warningEnvelope = {
    version: 1,
    nonce: "test",
    level: "warning",
    event: "m365.provider.aborted",
    detail: { message: "Aborted turn", safeDetails: {} },
  };

  assert.doesNotThrow(() => {
    dispatchStructuredLog(mockLogger, warningEnvelope);
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "warn");
  assert.equal(calls[0].event, "m365.provider.aborted");
});

test("TC-17: envelope schema is flat without nested detail.detail or duplicate level/event", () => {
  const logs = [];
  const mockLogger = {
    info(event, detail) {
      logs.push({ level: "info", event, detail });
    },
  };

  const envelope = {
    version: 1,
    nonce: "valid",
    level: "info",
    event: "codex.request.received",
    detail: {
      id: "evt_123",
      timestamp: new Date().toISOString(),
      processInstanceId: "proc_1",
      sequence: 1,
      source: "server",
      message: "Received request",
      traceId: "tr_123",
      spanId: "span_123",
      requestId: "req_123",
      safeDetails: { modelSlug: "gpt-5" },
    },
  };

  dispatchStructuredLog(mockLogger, envelope);

  assert.equal(logs.length, 1);
  const recorded = logs[0];
  assert.equal(recorded.event, "codex.request.received");
  // detail không được chứa 'level', 'event' hay lồng 'detail'
  assert.equal(recorded.detail.detail, undefined);
  assert.equal(recorded.detail.level, undefined);
  assert.equal(recorded.detail.event, undefined);
  assert.equal(recorded.detail.traceId, "tr_123");
  assert.equal(recorded.detail.safeDetails.modelSlug, "gpt-5");
});

test("TC-18: marker source code and Bearer tokens are redacted and excluded from Safe Export", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-test-export-"));
  const logFile = path.join(root, "launcher.jsonl");
  const exportFile = path.join(root, "safe-export.log");

  try {
    const logger = createLogger({ filePath: logFile });

    // 1. Ghi log có chứa source code nhạy cảm và secret
    logger.info("m365.tool.detected", {
      traceId: "tr_abc",
      spanId: "span_1",
      requestId: "req_1",
      safeDetails: {
        toolName: "write_file",
        callId: "call_999",
        argKeys: ["path", "content"],
        // Hacker cố tình inject các field lạ không nằm trong allowlist
        injectedSourceCode: "const secretKey = 'sk-live-12345';",
        injectedToken: "Bearer super-secret-token",
      },
    });

    // 2. Xuất Safe Log
    exportSanitizedLogs({ filePath: logFile, destinationPath: exportFile });
    assert.equal(fs.existsSync(exportFile), true);

    const exportedContent = fs.readFileSync(exportFile, "utf8");

    // 3. Kiểm tra bảo mật:
    // - Trường lạ `injectedSourceCode` và `injectedToken` phải bị loại bỏ hoàn toàn bởi allowlist
    assert.equal(exportedContent.includes("injectedSourceCode"), false);
    assert.equal(exportedContent.includes("injectedToken"), false);
    assert.equal(exportedContent.includes("sk-live-12345"), false);
    assert.equal(exportedContent.includes("super-secret-token"), false);

    // - Trường hợp lệ trong allowlist được giữ lại
    assert.equal(exportedContent.includes("write_file"), true);
    assert.equal(exportedContent.includes("call_999"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("filterSafeDetailsForExport strictly keeps allowlisted fields and strips secrets", () => {
  const filtered = filterSafeDetailsForExport("m365.tool.detected", {
    toolName: "exec_command",
    callId: "call_123",
    argKeys: ["cmd"],
    unknownField: "malicious_payload",
    authorization: "Bearer 12345",
  });

  assert.deepEqual(filtered, {
    toolName: "exec_command",
    callId: "call_123",
    argKeys: ["cmd"],
  });
});
