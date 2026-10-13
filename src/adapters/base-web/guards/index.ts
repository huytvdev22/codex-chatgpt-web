export * from "./dto";
export * from "./contracts";
export * from "./core";

import { BaseTitleGuard } from "./core";
export const defaultTitleGuard = new BaseTitleGuard();
export const isTitleRequest = defaultTitleGuard.isTitleRequest.bind(defaultTitleGuard);
export const generateTitleResponse = defaultTitleGuard.generateTitleResponse.bind(defaultTitleGuard);
export const isTitleGuardEnabled = defaultTitleGuard.isEnabled.bind(defaultTitleGuard);
