"use strict";

/**
 * Quản lý vòng đời WebContentsView theo cơ chế lazy-load.
 *
 * Mỗi provider chỉ có tối đa một renderer chính. View chỉ được tạo khi provider
 * được chọn lần đầu; view nền có thể ngủ đông hoặc bị hủy hoàn toàn.
 */
class ViewLifecycleManager {
  constructor({ window, createView, onCreate, logger }) {
    this.window = window;
    this.createView = createView;
    this.onCreate = onCreate;
    this.logger = logger;
    this.entries = new Map();
    this.destroyed = false;
  }

  has(key) {
    return this.entries.has(key);
  }

  get(key) {
    return this.entries.get(key)?.view || null;
  }

  values() {
    return [...this.entries.values()].map((entry) => entry.view);
  }

  ensure(key) {
    if (this.destroyed) throw new Error("ViewLifecycleManager has been destroyed");

    const current = this.entries.get(key);
    if (current && !current.view.webContents.isDestroyed()) {
      current.lastUsedAt = Date.now();
      return current.view;
    }

    if (current) this.entries.delete(key);
    const view = this.createView(key);
    const entry = {
      key,
      view,
      attached: false,
      hibernated: false,
      lastUsedAt: Date.now(),
    };
    this.entries.set(key, entry);
    this.attach(key);
    this.onCreate?.(key, view);
    return view;
  }

  attach(key) {
    const entry = this.entries.get(key);
    if (!entry || entry.attached || entry.view.webContents.isDestroyed()) return;
    this.window.contentView.addChildView(entry.view);
    entry.attached = true;
  }

  detach(key) {
    const entry = this.entries.get(key);
    if (!entry || !entry.attached) return;
    try {
      this.window.contentView.removeChildView(entry.view);
    } catch (error) {
      this.logger?.warn?.("browser.view_detach_failed", {
        provider: key,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    entry.attached = false;
  }

  activate(key, bounds) {
    const view = this.ensure(key);
    const entry = this.entries.get(key);
    this.attach(key);
    entry.hibernated = false;
    entry.lastUsedAt = Date.now();
    view.webContents.setBackgroundThrottling?.(true);
    view.setBounds(bounds);
    view.setVisible(true);
    return view;
  }

  hibernate(key, { blank = false } = {}) {
    const entry = this.entries.get(key);
    if (!entry || entry.view.webContents.isDestroyed()) return;

    entry.hibernated = true;
    entry.view.setVisible(false);
    this.detach(key);
    entry.view.webContents.setBackgroundThrottling?.(true);

    if (blank) {
      void entry.view.webContents.loadURL("about:blank").catch((error) => {
        this.logger?.warn?.("browser.view_hibernate_failed", {
          provider: key,
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  hibernateExcept(activeKey, options) {
    for (const key of this.entries.keys()) {
      if (key !== activeKey) this.hibernate(key, options);
    }
  }

  destroy(key) {
    const entry = this.entries.get(key);
    if (!entry) return false;

    this.entries.delete(key);
    this.detachEntry(entry);
    this.closeContents(entry.view);
    return true;
  }

  detachEntry(entry) {
    if (!entry.attached) return;
    try {
      this.window.contentView.removeChildView(entry.view);
    } catch (error) {
      this.logger?.warn?.("browser.view_detach_failed", {
        provider: entry.key,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    entry.attached = false;
  }

  closeContents(view) {
    const contents = view?.webContents;
    if (!contents || contents.isDestroyed()) return;

    contents.removeAllListeners();
    contents.close();
  }

  destroyAll() {
    if (this.destroyed) return;
    this.destroyed = true;

    for (const entry of this.entries.values()) {
      this.detachEntry(entry);
      this.closeContents(entry.view);
    }
    this.entries.clear();
  }
}

module.exports = { ViewLifecycleManager };
