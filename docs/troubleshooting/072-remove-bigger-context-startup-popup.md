# 072 - Gỡ bỏ popup gợi ý Bigger Context khi khởi động Launcher

> **Trạng thái:** ⏳ Chờ User Test & Confirm  
> **Providers:** `launcher`, `ui`  
> **Keywords:** `BiggerContextRecommendation`, `biggerContextRecommendationOpen`, `bigger-context-recommendation`, `popup`

## ⚡ TL;DR
1. **Triệu chứng:** Mỗi lần mở Launcher khi chưa bật `experimentalBiggerContext`, modal `Bigger Context (experimental) - Use up to 3× more context` tự động hiện đè lên giao diện trình duyệt (`browserSurfaceActive` bị chặn).
2. **Nguyên nhân gốc rễ:** `App.tsx` khởi tạo `biggerContextRecommendationOpen` là `true` khi `coreSetupComplete === true && !snapshot.state.experimentalBiggerContext` và render `BiggerContextRecommendation`.
3. **Cách sửa:** Gỡ bỏ component `BiggerContextRecommendation`, state `biggerContextRecommendationOpen` / `biggerContextRecommendationBusy`, handler `setRecommendedBiggerContext` trong [App.tsx](../../launcher/src/App.tsx), CSS `.bigger-context-recommendation*` trong [styles.css](../../launcher/src/styles.css) và 3 chuỗi i18n `biggerContextRecommendation*` trong [i18n.ts](../../launcher/src/i18n.ts); giữ nguyên switch `Bigger Context (experimental)` trong màn Settings.

## Thay đổi
- [launcher/src/App.tsx](../../launcher/src/App.tsx): Xóa `BiggerContextRecommendation`, state/handler liên quan và bỏ điều kiện `!biggerContextRecommendationOpen` khỏi `browserSurfaceActive`.
- [launcher/src/styles.css](../../launcher/src/styles.css): Xóa các rule `.bigger-context-recommendation*` (kể cả trong `@media (max-width: 760px)`).
- [launcher/src/i18n.ts](../../launcher/src/i18n.ts): Xóa 3 key `biggerContextRecommendationTitle`, `biggerContextRecommendationBody`, `biggerContextRecommendationToggleBody` ở cả 5 ngôn ngữ.
- [launcher/tests/renderer-wiring.test.cjs](../../launcher/tests/renderer-wiring.test.cjs): Cập nhật assertion xác nhận popup startup đã gỡ bỏ nhưng switch trong Settings vẫn hoạt động.

## Xác minh
- `bun run launcher:build`: Pass (`tsc --noEmit` + `vite build`).
- `bun run launcher:test`: 252 pass, 0 fail (2 skipped sẵn có của Windows installer).
- `bun test tests/launcher-localization.test.ts`: 1 pass, 0 fail.
