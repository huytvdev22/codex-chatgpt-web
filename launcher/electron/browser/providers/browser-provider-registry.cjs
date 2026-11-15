const { BaseBrowserProvider } = require("./base-browser-provider.cjs");

/**
 * Registry lưu trữ và tra cứu các Browser Provider đã đăng ký.
 * Cho phép mở rộng thêm provider mới mà không cần sửa switch/branch trong BrowserHost.
 */
class BrowserProviderRegistry {
  constructor() {
    this.providers = new Map();
    this._defaultId = null;
  }

  register(provider) {
    if (!(provider instanceof BaseBrowserProvider)) {
      throw new Error("Registered provider must be an instance of BaseBrowserProvider");
    }
    if (this.providers.has(provider.id)) {
      throw new Error(`Browser provider "${provider.id}" is already registered`);
    }
    this.providers.set(provider.id, provider);
    if (this._defaultId === null) {
      this._defaultId = provider.id;
    }
    return this;
  }

  get(id) {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new Error(`Unknown browser provider: ${id}`);
    }
    return provider;
  }

  has(id) {
    return typeof id === "string" && this.providers.has(id);
  }

  listIds() {
    return [...this.providers.keys()];
  }

  list() {
    return [...this.providers.values()];
  }

  defaultId() {
    return this._defaultId;
  }

  defaultProvider() {
    if (!this._defaultId) {
      throw new Error("No browser providers are registered");
    }
    return this.get(this._defaultId);
  }
}

module.exports = { BrowserProviderRegistry };

