export * from "./dto";
export * from "./contracts";
export * from "./core";

import { BaseToolBridge } from "./core";
export const M365ToolBridge = BaseToolBridge;
export const normalizeRequestUserInputArgs = BaseToolBridge.normalizeRequestUserInputArgs;
