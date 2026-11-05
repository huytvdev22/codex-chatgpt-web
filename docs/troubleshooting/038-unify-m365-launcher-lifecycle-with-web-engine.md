# 038: Đồng nhất M365 Launcher Lifecycle với `WebTurnEngine`

## ⚡ TL;DR
- **Triệu chứng:** M365 đã dùng `WebTurnEngine` cho protocol và retry nhưng `browser-worker.ts` vẫn tự start/end lease, kết nối CDP và đóng browser, khác bốn Web Adapter còn lại.
- **Nguyên nhân gốc rễ:** Đợt migration 031 ưu tiên bảo toàn runtime M365 nên giữ lifecycle cũ qua `manageLauncherLeaseInEngine: false`.
- **Cách sửa:** Đưa Launcher lifecycle về shared Web layer, cho M365 worker nhận `Page` như các provider khác và bảo toàn conversation binding, heartbeat, retry, attachment, abort cùng response extraction.

## Trạng thái
✅ Đã Confirm

## Kiến trúc hiện tại

```text
WebTurnEngine
  -> executeM365Turn()
      -> phase=start
      -> connect CDP
      -> kiểm tra retained conversation
      -> thao tác DOM và đọc response
      -> heartbeat
      -> phase=end
      -> đóng CDP
```

M365 đang đặt `manageLauncherLeaseInEngine: false`, vì vậy `runtime-lifecycle.ts` bỏ qua toàn bộ acquire/release cho provider này.

## Kiến trúc đích

```text
WebTurnEngine
  -> acquireWebTurnSurface()
      -> phase=start
      -> connect CDP
  -> M365 browser driver nhận Page
      -> kiểm tra retained conversation
      -> thao tác DOM và đọc response
      -> heartbeat qua shared lifecycle callback
      -> trả rawResponse + conversationId
  -> releaseWebTurnSurface()
      -> phase=end
      -> đóng CDP
```

## Invariant bắt buộc bảo toàn

1. Mỗi `conversationKey` tiếp tục đúng M365 conversation đã bind.
2. Retained `conversationId` phải khớp URL của surface được Launcher cấp.
3. Surface chưa bind nhưng đã chứa conversation phải bị từ chối.
4. Format retry tiếp tục trên đúng surface và conversation.
5. Attachment chỉ gửi ở attempt đầu tiên.
6. Heartbeat vẫn được gửi trong response polling.
7. Abort và lỗi đều release lease đúng một lần.
8. `connectorBound=true` chỉ khi hoàn thành và có `conversationId`.
9. CDP connection luôn được đóng, có timeout để không làm treo turn.
10. Không tăng số tab, renderer hoặc hiện tượng tab churn.
11. Copy-button salvage, FastPath và Semantic DOM fallback giữ nguyên kết quả.
12. Tool loop guard, protocol retry và event emission không đổi hành vi.

## Phạm vi triển khai

### Slice 1: Khóa lifecycle contract

- Bổ sung regression test cho start, heartbeat, end, abort, failure và retained conversation.
- Kiểm tra `phase=end` được gửi đúng một lần.
- Không đổi production path.

### Slice 2: Tách DOM worker nhận `Page`

- Tách phần từ kiểm tra URL đến trả `fullMarkdown` thành hàm nhận `Page`.
- Giữ `executeM365Turn()` làm wrapper lifecycle tạm thời.
- Không thay selector, polling, completion detection hoặc copy salvage.

### Slice 3: Mở rộng shared lifecycle cho M365

- Truyền metadata cần thiết vào browser driver:
  - leased `conversationId`
  - `launcherReused`
  - descriptor path hoặc heartbeat callback
- Đưa heartbeat về shared lifecycle API thay vì để DOM worker gọi trực tiếp Launcher.
- Bảo toàn chính sách lease hiện tại trước, chỉ đổi lease scope sau khi có test thực tế.

### Slice 4: Chuyển M365 sang shared lifecycle

- Bỏ `manageLauncherLeaseInEngine: false`.
- Khai báo `descriptorPath` và `resolveSurfaceId` cho M365.
- Browser driver bắt buộc nhận `Page`.
- Chuyển retained conversation validation sang conversation/browser driver.
- Trả `conversationId` từ worker để Engine bind khi release.

### Slice 5: Xóa compatibility path

- Xóa start/end/connect/close khỏi M365 worker.
- Xóa utility chỉ còn phục vụ lifecycle cũ.
- Cập nhật architecture gate để cấm mọi provider worker tự quản lý Launcher lease.
- Cập nhật tài liệu kiến trúc sau khi user test xác nhận.

## Cổng kiểm chứng

```bash
git diff --check
bun run check:architecture
bun test tests/web-turn-engine.test.ts
bun test tests/m365-*.test.ts
bun run build
```

## Kiểm thử thủ công bắt buộc

- Turn đầu tạo conversation mới.
- Turn thứ hai tiếp tục đúng conversation.
- Tool call và tool-result continuation.
- Format retry không mở chat mới.
- Upload một và nhiều ảnh.
- Abort khi đang streaming.
- Lỗi DOM hoặc mất kết nối giữa turn.
- Khởi động lại Launcher rồi tiếp tục retained conversation.
- Nhiều turn liên tiếp không tăng tab hoặc renderer bất thường.

## Quyết định

- Ưu tiên tính đồng nhất kiến trúc hơn giữ ngoại lệ M365 lâu dài.
- Không thay selector hoặc thuật toán response extraction trong cùng slice với lifecycle migration.
- Không chuyển bốn adapter khác sang tự quản lý Launcher.
- Không giữ hai production path sau khi đường shared đã được user xác nhận.
