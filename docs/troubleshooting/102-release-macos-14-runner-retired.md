# 102 - Workflow Release `v6.13.0` fail job macOS ARM64 do runner `macos-14` đã ngừng hỗ trợ

> **Trạng thái:** ⏳ Chờ User Test & Confirm  
> **Ngày phát hiện:** 2026-11-26  
> **Phạm vi:** `.github/workflows/release.yml`

## ⚡ TL;DR
1. **Triệu chứng:** Job `build (macos-14, codex-chatgpt-web-darwin-arm64.tar.gz)` trên GitHub Actions (run `45621758828`) bị `cancelled` ngay lập tức với lỗi `The configuration 'macos-14-arm64-us-default' is not supported`, làm job `publish` bị `skipped`.
2. **Nguyên nhân gốc rễ:** GitHub Actions đã retire runner `macos-14` từ ngày 02/11/2026; `ci.yml` đã chuyển sang `macos-15` nhưng `release.yml` vẫn giữ `runner: macos-14`.
3. **Cách sửa:** Đổi `runner: macos-14` thành `runner: macos-15` trong [.github/workflows/release.yml](../../.github/workflows/release.yml#L21) để đồng bộ với `ci.yml` và `macos-15-intel`.
