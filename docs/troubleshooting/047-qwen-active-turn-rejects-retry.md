# 047 — Qwen Web từ chối lượt mới: "conversation is currently active with another turn"

**Trạng thái:** `✅ Đã Confirm`

## ⚡ TL;DR
- **Triệu chứng:** Lượt Qwen kế tiếp (sau khi hoàn tất, bị hủy hoặc lỗi kết nối) lỗi `stream disconnected before completion: [qwen-adapter] Không thể kết nối với Launcher browser tab: ... HTTP 400: Qwen Web conversation is currently active with another turn; wait for it to complete`; Launcher log lặp `browser.orphan_turn_cancel_failed` và đóng tab thủ công thất bại.
- **Nguyên nhân gốc rễ:** (1) `releaseWebTurnSurface` truyền `req.signal` (bị Bun hủy ngay khi đóng SSE sau `done`) vào `phase=end` gây `AbortError`; (2) `startLauncherBrowserTurn` không gửi `phase=end` nếu `connectLauncherBrowserHost` lỗi sau khi `phase=start` đã cấp lease; (3) `POST /admin/cancel-turn` trong `src/server.ts` trả stub thiếu `trace_id` và không hủy browser turn đang chạy khiến `reapExpiredTurnTabs` và đóng tab trên Launcher luôn ném lỗi xác nhận.
- **Cách sửa:** Không truyền request signal vào `phase=end`; tự động gửi `phase=end` dọn lease nếu kết nối CDP thất bại sau `phase=start`; bổ sung `WebTurnCancellationRegistry` cho `WebTurnEngine` + hoàn thiện `/admin/cancel-turn`, `/admin/cancel-turns`, `/health` (`active_browser_turns`); phía Launcher thêm reclaim tab quá hạn heartbeat (< 90s) và `waitForActiveTurn` có giới hạn (20s).

## Chi tiết thay đổi
- `src/adapters/web/runtime-lifecycle.ts`: `endTurn` dùng `signal: undefined` để `phase=end` luôn tới Launcher khi SSE/request đóng.
- `src/adapters/web/launcher-runtime.ts`: `startLauncherBrowserTurn` bọc phần hậu `phase=start` bằng `try/catch`; nếu `resolveSurfaceId` hoặc `connectLauncherBrowserHost` lỗi/hủy sẽ gửi `phase=end` (`retain: false`, `connectorBound: false`, `signal: undefined`) trước khi ném lại lỗi.
- `src/adapters/web/turn-identity.ts` & `src/adapters/web/engine.ts`: thêm `WebTurnCancellationRegistry` (`activeWebTurnRegistry`) đăng ký `traceId -> AbortController` bao trùm từ `acquireWebTurnSurface` tới `releaseWebTurnSurface`.
- `src/server.ts`: triển khai `POST /admin/cancel-turn` kiểm tra `traceId` (`/^[A-Za-z0-9_-]{6,128}$/`), hủy đúng turn trong `activeWebTurnRegistry` và trả `trace_id: traceId`; cập nhật `active_browser_turns` và `POST /admin/cancel-turns`.
- `launcher/electron/qwen-surface-manager.cjs` & `launcher/electron/browser-host.cjs`: thêm `isLiveRunningTab`, `activeTurnFor`, `waitForActiveTurn` (chờ tối đa 20s trong `beginTurn` của `qwen`, thu hồi tab running quá hạn heartbeat 90s).
- Tests:
  - `tests/web-turn-engine.test.ts`: cập nhật test 12 (`endTurn` nhận `signal === undefined`) và thêm test 23 (`startLauncherBrowserTurn` gửi `phase=end` khi `connectBrowserHost` lỗi hoặc bị abort).
  - `tests/admin-cancel-turn.test.ts`: 3 test xác nhận hợp đồng 401/400/200 (`trace_id`), hủy đúng target turn giữ nguyên peer turn, và `/admin/cancel-turns` hủy cả turn đang chờ `acquireWebTurnSurface`.
  - `launcher/tests/qwen-surface-manager.test.cjs`: thêm 3 test (heartbeat quá hạn, chờ lượt cũ release, hết thời gian chờ).

## Kiểm chứng tự động (sau lần sửa cuối)
```bash
bun run check:architecture                                                              # 0 cycles, 5 pass, 0 fail (493 expects)
bun test tests/web-turn-engine.test.ts tests/qwen-web-adapter.test.ts tests/qwen-conversation-store.test.ts tests/admin-cancel-turn.test.ts   # 40 pass, 0 fail
bun test launcher/tests/qwen-surface-manager.test.cjs                                   # 10 pass, 0 fail
bun run --cwd launcher typecheck                                                        # pass (0 errors)
bun x tsc --noEmit -p .                                                                 # 0 errors trên các file đã sửa (còn lỗi sẵn có ở chatgpt-browser-worker / scripts smoke)
```

## User test
1. **Bắt buộc khởi động lại cả Launcher và runtime server** (`bun run src/cli.ts serve`) để nạp code mới ở cả hai phía và xóa tab kẹt từ tiến trình cũ.
2. Gửi nhiều lượt liên tiếp trong cùng conversation Qwen, thử cả hủy giữa chừng và đóng tab trên Launcher.
3. Xác nhận log không còn `Không thể gửi phase=end tới launcher: DOMException`, `browser.orphan_turn_cancel_failed`, hay HTTP 400 `currently active with another turn`.
