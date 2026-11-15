const path = require("node:path");
const { Menu, nativeImage, Tray } = require("electron");

const NATIVE_COPY = Object.freeze({
  "en": Object.freeze({
    openLauncher: "Open Codex Web GPT",
    quit: "Quit",
    exportDiagnostics: "Export privacy-safe diagnostics",
    cancel: "Cancel",
    remove: "Remove",
    removeTitle: "Remove Codex Web GPT",
    removeMessage: "Remove the ChatGPT Web models from Codex and restore the previous model route?",
    removeDetail: "The launcher's ChatGPT login profile will be preserved. Codex must be restarted once.",
    retry: "Retry",
    startupTitle: "Codex Web GPT could not start",
    startupDetail: "Retry starts the launcher again without changing your saved settings or ChatGPT profile.",
    startupCleanupFailed: "Startup cleanup failed",
    catalogFailure: "Codex reached the launcher, but loading its model catalog failed (HTTP {status}; {reason}). Restart the launcher and review the local launcher log if the problem persists.",
  }),
  "zh-CN": Object.freeze({
    openLauncher: "打开 Codex Web GPT",
    quit: "退出",
    exportDiagnostics: "导出隐私安全诊断",
    cancel: "取消",
    remove: "移除",
    removeTitle: "移除 Codex Web GPT",
    removeMessage: "从 Codex 中移除 ChatGPT Web 模型并恢复此前的模型路由？",
    removeDetail: "启动器中的 ChatGPT 登录 profile 会保留。Codex 需要重启一次。",
    retry: "重试",
    startupTitle: "Codex Web GPT 无法启动",
    startupDetail: "重试会重新启动应用，不会更改已保存的设置或 ChatGPT 登录配置。",
    startupCleanupFailed: "启动清理失败",
    catalogFailure: "Codex 已连接到启动器，但模型列表加载失败（HTTP {status}；{reason}）。请查看“活动”了解详情；若问题持续，请导出安全日志。",
  }),
  "zh-TW": Object.freeze({
    openLauncher: "開啟 Codex Web GPT",
    quit: "結束",
    exportDiagnostics: "匯出隱私安全診斷",
    cancel: "取消",
    remove: "移除",
    removeTitle: "移除 Codex Web GPT",
    removeMessage: "從 Codex 中移除 ChatGPT Web 模型並還原先前的模型路由？",
    removeDetail: "啟動器中的 ChatGPT 登入設定檔會保留。Codex 需要重新啟動一次。",
    retry: "重試",
    startupTitle: "Codex Web GPT 無法啟動",
    startupDetail: "重試會重新啟動應用程式，不會變更已儲存的設定或 ChatGPT 登入設定檔。",
    startupCleanupFailed: "啟動清理失敗",
    catalogFailure: "Codex 已連線到啟動器，但模型清單載入失敗（HTTP {status}；{reason}）。請查看「活動」了解詳情；若問題持續，請匯出安全日誌。",
  }),
  "ja": Object.freeze({
    openLauncher: "Codex Web GPT を開く",
    quit: "終了",
    exportDiagnostics: "プライバシー保護済みの診断情報をエクスポート",
    cancel: "キャンセル",
    remove: "削除",
    removeTitle: "Codex Web GPT を削除",
    removeMessage: "Codex から ChatGPT Web モデルを削除し、以前のモデルルートを復元しますか？",
    removeDetail: "ランチャーの ChatGPT ログインプロファイルは保持されます。Codex を一度再起動する必要があります。",
    retry: "再試行",
    startupTitle: "Codex Web GPT を起動できませんでした",
    startupDetail: "保存済みの設定と ChatGPT プロファイルを変更せずに、ランチャーを再起動します。",
    startupCleanupFailed: "起動後のクリーンアップに失敗しました",
    catalogFailure: "Codex はランチャーに接続しましたが、モデル一覧を読み込めませんでした（HTTP {status}、{reason}）。「アクティビティ」で詳細を確認し、問題が続く場合は安全なログをエクスポートしてください。",
  }),
  "ko": Object.freeze({
    openLauncher: "Codex Web GPT 열기",
    quit: "종료",
    exportDiagnostics: "개인정보가 보호된 진단 정보 내보내기",
    cancel: "취소",
    remove: "제거",
    removeTitle: "Codex Web GPT 제거",
    removeMessage: "Codex에서 ChatGPT Web 모델을 제거하고 이전 모델 경로를 복원할까요?",
    removeDetail: "런처의 ChatGPT 로그인 프로필은 유지됩니다. Codex를 한 번 다시 시작해야 합니다.",
    retry: "다시 시도",
    startupTitle: "Codex Web GPT를 시작할 수 없습니다",
    startupDetail: "저장된 설정이나 ChatGPT 프로필을 변경하지 않고 런처를 다시 시작합니다.",
    startupCleanupFailed: "시작 정리에 실패했습니다",
    catalogFailure: "Codex가 런처에 연결했지만 모델 목록을 불러오지 못했습니다(HTTP {status}; {reason}). 활동에서 세부 정보를 확인하고 문제가 계속되면 안전한 로그를 내보내 주세요.",
  }),
});

function nativeCopyFor(language) {
  return NATIVE_COPY[language] || NATIVE_COPY.en;
}

class TrayController {
  constructor({ logger, appIconPath, displayName, showMainWindow, requestQuit, platform = process.platform }) {
    this.logger = logger;
    this.appIconPath = appIconPath;
    this.displayName = displayName;
    this.showMainWindow = showMainWindow;
    this.requestQuit = requestQuit;
    this.platform = platform;
    this.tray = null;
  }

  trayImage() {
    if (this.platform !== "darwin") {
      return nativeImage.createFromPath(this.appIconPath).resize({ width: 18, height: 18 });
    }
    const image = nativeImage.createFromPath(path.join(__dirname, "../..", "assets", "trayTemplate.png"));
    if (image.isEmpty()) throw new Error("The macOS menu-bar icon is missing or invalid");
    image.setTemplateImage(true);
    return image;
  }

  create(language) {
    try {
      this.tray = new Tray(this.trayImage());
      this.tray.setToolTip(this.displayName);
      this.updateMenu(language);
      this.tray.on("click", () => this.showMainWindow());
      return true;
    } catch (error) {
      this.tray = null;
      this.logger.warn("launcher.tray_unavailable", {
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  updateMenu(language) {
    if (!this.tray) return;
    const copy = nativeCopyFor(language);
    this.tray.setContextMenu(Menu.buildFromTemplate([
      { label: copy.openLauncher, click: () => this.showMainWindow() },
      { type: "separator" },
      { label: copy.quit, click: () => { void this.requestQuit(); } },
    ]));
  }

  isAvailable() {
    return Boolean(this.tray);
  }
}

module.exports = {
  NATIVE_COPY,
  nativeCopyFor,
  TrayController,
};

