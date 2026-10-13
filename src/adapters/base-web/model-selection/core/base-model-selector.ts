import type { Page } from "playwright-core";
import type { IModelSelector } from "../contracts/model-selector.interface";
import type { IDomDriver } from "../contracts/dom-driver.interface";
import type { IModelVerifier } from "../contracts/model-verifier.interface";
import type { IMenuNavigationStrategy } from "../contracts/menu-navigation-strategy.interface";
import { ModelSelectionRequestDto } from "../dto/model-selection-request.dto";
import { ModelSelectionResultDto, SelectionStatusCode } from "../dto/model-selection-result.dto";
import { ModelSpecDto } from "../dto/model-spec.dto";
import { PlaywrightDomDriver } from "../infrastructure/playwright-dom-driver";

/**
 * Lớp điều phối khung Template Method cấp cao cho toàn bộ Web Chat Providers
 * Tuân thủ Clean Architecture: Thuật toán 6 bước chuẩn mực
 */
export abstract class BaseModelSelector<TMode extends string = string> implements IModelSelector<TMode> {
  abstract readonly selectorName: string;

  protected abstract readonly modelVerifier: IModelVerifier<TMode>;
  protected abstract readonly navigationStrategies: readonly IMenuNavigationStrategy<TMode>[];
  protected abstract readonly specsMap: ReadonlyMap<TMode, ModelSpecDto<TMode>>;

  // ===========================================================================
  // TEMPLATE METHOD: Cố định thuật toán 6 bước chuẩn mực
  // ===========================================================================
  public async ensureModel(
    driver: IDomDriver,
    request: ModelSelectionRequestDto<TMode>
  ): Promise<ModelSelectionResultDto<TMode>> {
    const startTime = Date.now();
    const spec = this.specsMap.get(request.targetMode);

    if (!spec) {
      return ModelSelectionResultDto.createFailure(
        request.targetMode,
        SelectionStatusCode.ITEM_NOT_FOUND,
        Date.now() - startTime,
        `[${this.selectorName}] Không tìm thấy cấu hình ModelSpec cho mode: '${request.targetMode}'`
      );
    }

    try {
      // BƯỚC 1: Fast-path Check (Kiểm tra nhanh xem UI đã ở đúng mode chưa)
      if (!request.forceReselect) {
        const isAlreadyActive = await this.modelVerifier.isModelActive(driver, spec).catch(() => false);
        if (isAlreadyActive) {
          console.log(`[${this.selectorName}] Mode '${spec.label}' (${request.targetMode}) đã được kích hoạt sẵn trên UI.`);
          return ModelSelectionResultDto.createAlreadyActive(
            request.targetMode,
            Date.now() - startTime,
            spec.label
          );
        }
      }

      console.log(`[${this.selectorName}] Bắt đầu quy trình chuyển sang model: '${spec.label}' (${request.targetMode})...`);

      // BƯỚC 2: Chọn Chiến Lược Điều Hướng Phù Hợp (Strategy Resolution)
      const strategy = this.resolveStrategy(spec);
      if (!strategy) {
        return ModelSelectionResultDto.createFailure(
          request.targetMode,
          SelectionStatusCode.ITEM_NOT_FOUND,
          Date.now() - startTime,
          `[${this.selectorName}] Không tìm thấy Navigation Strategy nào hỗ trợ spec '${spec.mode}'`
        );
      }

      // BƯỚC 3: Mở Menu thông qua Strategy
      const menuOpened = await strategy.openMenu(driver);
      if (!menuOpened) {
        return ModelSelectionResultDto.createFailure(
          request.targetMode,
          SelectionStatusCode.MENU_OPEN_FAILED,
          Date.now() - startTime,
          `[${this.selectorName}] Không thể mở menu chọn model bằng strategy '${strategy.strategyName}'`
        );
      }

      // Đợi popup menu Fluent UI / React render vào DOM (tương tự waitForSelector trong code gốc)
      await driver.sleep(300);

      // BƯỚC 4: Click chọn Item
      const selectionStep = await strategy.selectItem(driver, spec);

      if (selectionStep.alreadyChecked) {
        await strategy.closeMenu(driver);
        console.log(`[${this.selectorName}] Mode '${spec.label}' thực tế đã được checked sẵn trong menu.`);
        return ModelSelectionResultDto.createAlreadyActive(
          request.targetMode,
          Date.now() - startTime,
          spec.label
        );
      }

      if (!selectionStep.clicked) {
        await strategy.closeMenu(driver);
        return ModelSelectionResultDto.createFailure(
          request.targetMode,
          SelectionStatusCode.ITEM_NOT_FOUND,
          Date.now() - startTime,
          `[${this.selectorName}] Click item thất bại: ${selectionStep.reason || "Lý do không xác định"}`
        );
      }

      // BƯỚC 5: Đợi UI Settle (Ổn định lại DOM)
      const delay = request.settleDelayMs > 0 ? request.settleDelayMs : 300;
      await driver.sleep(delay);

      console.log(`[${this.selectorName}] Chuyển đổi thành công sang model: '${spec.label}' (${request.targetMode})`);
      return ModelSelectionResultDto.createSuccess(
        request.targetMode,
        Date.now() - startTime,
        spec.label
      );

    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      await driver.pressKey("Escape").catch(() => {});
      console.warn(`[${this.selectorName}] Lỗi bất ngờ trong quá trình chọn model:`, err);
      return ModelSelectionResultDto.createFailure(
        request.targetMode,
        SelectionStatusCode.DRIVER_ERROR,
        Date.now() - startTime,
        `[${this.selectorName}] Gặp lỗi khi chọn model: ${err.message}`,
        err
      );
    }
  }

  /**
   * Facade tiện ích nhận trực tiếp Playwright Page
   */
  public async ensureMode(page: Page, targetMode: TMode): Promise<boolean> {
    const driver = new PlaywrightDomDriver(page);
    const request = ModelSelectionRequestDto.of(targetMode);
    const result = await this.ensureModel(driver, request);
    return result.isOk();
  }

  protected resolveStrategy(spec: ModelSpecDto<TMode>): IMenuNavigationStrategy<TMode> | undefined {
    return this.navigationStrategies.find(s => s.supports(spec));
  }

  public abstract resolveMode(modelSlug?: string, reasoning?: string): TMode;

  public getSupportedSpecs(): ReadonlyMap<TMode, ModelSpecDto<TMode>> {
    return this.specsMap;
  }
}
