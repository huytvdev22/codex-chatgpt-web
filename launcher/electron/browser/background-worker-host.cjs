"use strict";

const { BrowserWindow } = require("electron");
const {
  IDLE_BROWSER_URL,
  loadCommittedBrowserSurface,
} = require("./turn-tab-manager.cjs");

const DEFAULT_WORKER_VIEWPORT = Object.freeze({ width: 1280, height: 800 });
const WORKER_HOST_BOOTSTRAP_TIMEOUT_MS = 10_000;

/**
 * Sở hữu một `BrowserWindow` ẩn riêng (`show: false`, `focusable: false`,
 * `paintWhenInitiallyHidden: true`) làm sân chạy nền cố định cho mọi turn tab.
 *
 * Việc tách khỏi `mainWindow` giúp toàn bộ automation tab giữ viewport desktop
 * ổn định (`1280×800`) và nhịp compositor ~60 FPS bất kể người dùng ẩn, thu nhỏ,
 * đổi kích thước hay chuyển tab trên cửa sổ Launcher chính.
 */
class BackgroundWorkerHost {
  constructor({
    createWindow = null,
    loadIdleSurface = null,
    logger = null,
    viewport = DEFAULT_WORKER_VIEWPORT,
    idleUrl = IDLE_BROWSER_URL,
  } = {}) {
    this.createWindow = createWindow;
    this.loadIdleSurface = loadIdleSurface;
    this.logger = logger;
    this.viewport = Object.freeze({
      width: Math.max(1024, Math.round(viewport?.width || DEFAULT_WORKER_VIEWPORT.width)),
      height: Math.max(720, Math.round(viewport?.height || DEFAULT_WORKER_VIEWPORT.height)),
    });
    this.idleUrl = idleUrl;
    this.window = null;
    this.readyPromise = null;
    this.attachedViews = new Set();
    this.destroyed = false;
  }

  getBounds() {
    return {
      x: 0,
      y: 0,
      width: this.viewport.width,
      height: this.viewport.height,
    };
  }

  _buildDefaultWindow() {
    const win = new BrowserWindow({
      width: this.viewport.width,
      height: this.viewport.height,
      show: false,
      paintWhenInitiallyHidden: true,
      skipTaskbar: true,
      focusable: false,
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    if (typeof win.setMenuBarVisibility === "function") {
      win.setMenuBarVisibility(false);
    }
    win.on?.("close", (event) => {
      if (!this.destroyed) event.preventDefault();
    });
    return win;
  }

  ensureWindow() {
    if (this.destroyed) {
      throw new Error("BackgroundWorkerHost has been destroyed");
    }
    if (this.window && !this.window.isDestroyed?.()) {
      return this.window;
    }
    this.window = typeof this.createWindow === "function"
      ? this.createWindow(this.viewport)
      : this._buildDefaultWindow();
    this.attachedViews.clear();
    return this.window;
  }

  /**
   * Nạp tài liệu rỗng hợp lệ (`IDLE_BROWSER_URL`) cho `workerWindow` để tránh
   * trạng thái empty document (`url: ""`) làm treo Playwright `connectOverCDP` (Lỗi 098).
   */
  async ensureReady() {
    if (this.destroyed) {
      throw new Error("BackgroundWorkerHost has been destroyed");
    }
    if (this.readyPromise) return this.readyPromise;
    const win = this.ensureWindow();
    const contents = win?.webContents;
    if (!contents || contents.isDestroyed?.()) {
      return;
    }
    const loader = typeof this.loadIdleSurface === "function"
      ? this.loadIdleSurface
      : (targetContents, url) => loadCommittedBrowserSurface(
          targetContents,
          url,
          WORKER_HOST_BOOTSTRAP_TIMEOUT_MS,
        );
    const task = Promise.resolve()
      .then(() => loader(contents, this.idleUrl))
      .then(() => {
        this.logger?.info?.("browser.worker_host_ready", {
          width: this.viewport.width,
          height: this.viewport.height,
        });
      })
      .catch((error) => {
        if (this.readyPromise === task) this.readyPromise = null;
        this.logger?.warn?.("browser.worker_host_bootstrap_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      });
    this.readyPromise = task;
    return task;
  }

  hasView(view) {
    return Boolean(view && this.attachedViews.has(view));
  }

  attachView(view, { visible = true } = {}) {
    if (!view || this.destroyed) return false;
    const win = this.ensureWindow();
    if (!this.attachedViews.has(view)) {
      win.contentView?.addChildView?.(view);
      this.attachedViews.add(view);
    }
    view.setBounds?.(this.getBounds());
    view.setVisible?.(Boolean(visible));
    return true;
  }

  detachView(view) {
    if (!view || !this.attachedViews.has(view)) return false;
    this.attachedViews.delete(view);
    const win = this.window;
    if (win && !win.isDestroyed?.()) {
      try {
        win.contentView?.removeChildView?.(view);
      } catch (error) {
        this.logger?.warn?.("browser.worker_host_detach_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.readyPromise = null;
    const win = this.window;
    for (const view of [...this.attachedViews]) {
      this.attachedViews.delete(view);
      if (win && !win.isDestroyed?.()) {
        try {
          win.contentView?.removeChildView?.(view);
        } catch {}
      }
    }
    if (win && !win.isDestroyed?.()) {
      try {
        win.destroy();
      } catch {}
    }
    this.window = null;
  }
}

module.exports = {
  BackgroundWorkerHost,
  DEFAULT_WORKER_VIEWPORT,
  WORKER_HOST_BOOTSTRAP_TIMEOUT_MS,
};
