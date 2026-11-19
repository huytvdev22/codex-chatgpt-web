import type { ProviderAdapter } from "./base";
import { createAiStudioAdapter } from "./ai-studio";
import { createM365CopilotAdapter } from "./m365-copilot";

export type ProviderAdapterFactory = () => ProviderAdapter;

/**
 * Registry trung tâm quản lý factory khởi tạo `ProviderAdapter` theo `providerId`.
 *
 * Tách biệt rõ vai trò với `ModelRegistry`:
 * - `ModelRegistry` ánh xạ `modelId -> BaseModelProvider` (metadata thuần, không kéo Playwright/runtime).
 * - `AdapterRegistry` ánh xạ `providerId -> ProviderAdapter` (runtime thực thi lượt tương tác).
 */
export class AdapterRegistry {
  private static readonly defaultInstance = new AdapterRegistry([
    ["m365-copilot", createM365CopilotAdapter],
    ["ai-studio", createAiStudioAdapter],
  ]);

  private readonly factories = new Map<string, ProviderAdapterFactory>();

  constructor(entries: ReadonlyArray<readonly [string, ProviderAdapterFactory]> = []) {
    for (const [providerId, factory] of entries) {
      this.factories.set(providerId, factory);
    }
  }

  /** Trả về instance mặc định toàn cục đã đăng ký các adapter đang bật. */
  public static getInstance(): AdapterRegistry {
    return AdapterRegistry.defaultInstance;
  }

  /** Đăng ký hoặc ghi đè factory cho một `providerId`. */
  public register(providerId: string, factory: ProviderAdapterFactory): this {
    this.factories.set(providerId, factory);
    return this;
  }

  /** Kiểm tra `providerId` đã có factory đăng ký hay chưa. */
  public has(providerId: string): boolean {
    return this.factories.has(providerId);
  }

  /** Liệt kê danh sách `providerId` hiện có factory thực thi. */
  public listProviderIds(): string[] {
    return [...this.factories.keys()];
  }

  /** Khởi tạo một instance `ProviderAdapter` mới cho `providerId`. */
  public createAdapter(providerId: string): ProviderAdapter {
    const factory = this.factories.get(providerId);
    if (!factory) {
      throw new Error(`No adapter factory registered for provider '${providerId}'.`);
    }
    return factory();
  }
}

