import { resolve } from "node:path";
import type { ProviderAdapterFactory } from "./adapters/adapter-registry";
import { formatErrorResponse } from "./bridge";
import { reconcileCodexModelCatalogConfig, type CodexModelContextOverride } from "./codex-integration";
import type { AppConfig } from "./config";
import { AdminController } from "./controllers/admin-controller";
import { HttpTurnCounter, type NativeCodexTurnIdentity } from "./controllers/http-turn-counter";
import { ModelsController, type ModelCatalogFailure } from "./controllers/models-controller";
import { ResponsesController } from "./controllers/responses-controller";
import { applyLoopbackCors, serveUniversal, type UniversalServer } from "./controllers/universal-http-server";
import { ModelCatalog } from "./models/model-catalog";
import { flushResponseState } from "./responses/state";
import { ResponsesService, type ResponseRequestOptions } from "./services/responses-service";

export { HttpTurnCounter, type HttpStreamFailureEvidence, type NativeCodexTurnIdentity } from "./controllers/http-turn-counter";
export { type UniversalServer } from "./controllers/universal-http-server";
export { type ResponseRequestOptions } from "./services/responses-service";

const defaultModelsController = new ModelsController();
const defaultResponsesController = new ResponsesController();

/**
 * Facade tương thích ngược cho `GET /v1/models` (được dùng bởi các test trực tiếp).
 */
export async function modelsRequest(
  req: Request,
  config: AppConfig,
  contextOverride?: () => CodexModelContextOverride | undefined,
  onFailure?: (failure: ModelCatalogFailure) => void,
): Promise<Response> {
  return await defaultModelsController.handleModelsRequest(req, config, contextOverride, onFailure);
}

/**
 * Facade tương thích ngược cho `POST /v1/responses` (được dùng bởi các test trực tiếp).
 */
export async function responseRequest(
  req: Request,
  _config: AppConfig,
  adapterFactory?: ProviderAdapterFactory,
  options: ResponseRequestOptions = {},
): Promise<Response> {
  return await defaultResponsesController.handleResponses(req, options, adapterFactory);
}

/**
 * Facade tương thích ngược cho `POST /v1/responses/compact` (được dùng bởi các test trực tiếp).
 */
export async function compactRequest(
  req: Request,
  _config: AppConfig,
  adapterFactory?: ProviderAdapterFactory,
  options: Pick<ResponseRequestOptions, "onTurnIdentity"> = {},
): Promise<Response> {
  return await defaultResponsesController.handleCompact(req, options, adapterFactory);
}

/**
 * Khởi chạy HTTP server cục bộ và định tuyến request tới các Controller tương ứng.
 */
export function startServer(
  config: AppConfig,
  dependencies: { adapterFactory?: ProviderAdapterFactory } = {},
): UniversalServer {
  try {
    ModelCatalog.getInstance().ensureManagedCatalogFile(config);
    reconcileCodexModelCatalogConfig();
  } catch (error) {
    console.warn(`[codex-chatgpt-web] could not sync model catalog: ${error instanceof Error ? error.message : String(error)}`);
  }

  const startedAt = Date.now();
  let draining = false;
  let shutdownPromise: Promise<void> | undefined;

  const httpTurns = new HttpTurnCounter();
  const modelsController = new ModelsController();
  const responsesController = new ResponsesController(new ResponsesService());

  let server!: UniversalServer;
  const shutdown = (): void => {
    if (shutdownPromise) return;
    draining = true;
    flushResponseState();
    shutdownPromise = (async () => {
      await server.stop(true);
    })().catch(error => {
      process.exitCode = 1;
      console.error(`[codex-chatgpt-web] server shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  };

  const adminController = new AdminController({
    config,
    startedAt,
    swaggerPath: resolve(import.meta.dir, "..", "docs", "swagger.html"),
    httpTurns,
    getModelsMetrics: () => modelsController.getMetricsSnapshot(),
    isDraining: () => draining,
    setDraining: next => { draining = next; },
    shutdown,
  });

  const handleRequest = async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204 });
    }

    const url = new URL(req.url);
    if (req.method === "GET" && (url.pathname === "/docs" || url.pathname === "/swagger")) {
      return adminController.handleDocs();
    }
    if (req.method === "GET" && url.pathname === "/healthz") {
      return adminController.handleHealthz();
    }
    if (req.method === "POST" && (url.pathname === "/admin/drain" || url.pathname === "/admin/resume")) {
      return adminController.handleDrainToggle(req, url.pathname === "/admin/drain");
    }
    if (req.method === "POST" && url.pathname === "/admin/cancel-turn") {
      return await adminController.handleCancelTurn(req);
    }
    if (req.method === "POST" && url.pathname === "/admin/interrupt-turn") {
      return await adminController.handleInterruptTurn(req);
    }
    if (req.method === "POST" && url.pathname === "/admin/cancel-turns") {
      return await adminController.handleCancelTurns(req);
    }
    if (req.method === "POST" && url.pathname === "/admin/shutdown") {
      return adminController.handleShutdown(req);
    }
    if (req.method === "GET" && url.pathname === "/v1/models") {
      return await modelsController.handleRoute(req, config, httpTurns, draining);
    }
    if (req.method === "GET" && url.pathname === "/v1/responses") {
      return responsesController.handleUnsupportedGet();
    }
    if (req.method === "POST" && url.pathname === "/v1/responses") {
      if (draining) {
        return formatErrorResponse(503, "server_error", "codex-chatgpt-web is draining for a requested service operation");
      }
      return httpTurns.track(
        (signal, bindIdentity) => responsesController.handleResponses(
          new Request(req, { signal }),
          { onTurnIdentity: bindIdentity },
          dependencies.adapterFactory,
        ),
        req.signal,
        process.platform,
        "responses",
      );
    }
    if (req.method === "POST" && url.pathname === "/v1/responses/compact") {
      if (draining) {
        return formatErrorResponse(503, "server_error", "codex-chatgpt-web is draining for a requested service operation");
      }
      return httpTurns.track(
        (signal, bindIdentity) => responsesController.handleCompact(
          new Request(req, { signal }),
          { onTurnIdentity: bindIdentity },
          dependencies.adapterFactory,
        ),
        req.signal,
        process.platform,
        "compact",
      );
    }

    return new Response("Not found", { status: 404 });
  };

  server = serveUniversal({
    hostname: config.host,
    port: config.port,
    idleTimeout: 0,
    async fetch(req) {
      return applyLoopbackCors(req, await handleRequest(req));
    },
  });

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  return server;
}
