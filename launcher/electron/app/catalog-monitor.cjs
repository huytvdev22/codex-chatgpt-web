const { nativeCopyFor } = require("./tray-controller.cjs");

class CatalogMonitor {
  constructor({
    logger,
    stateStore,
    getRuntimeSupervisor,
    getRuntimeHost,
    getLastOperation,
    publishOperation,
    send,
  }) {
    this.logger = logger;
    this.stateStore = stateStore;
    this.getRuntimeSupervisor = getRuntimeSupervisor;
    this.getRuntimeHost = getRuntimeHost;
    this.getLastOperation = getLastOperation;
    this.publishOperation = publishOperation;
    this.send = send;
    this.timer = null;
    this.inFlight = false;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  start() {
    this.stop();
    let reportedFailure = null;
    const check = async () => {
      const current = this.stateStore.read();
      if (current.coreSetupComplete !== true || current.codexCatalogVerified === true) {
        this.stop();
        return;
      }
      const runtimeSupervisor = this.getRuntimeSupervisor();
      if (this.inFlight || !runtimeSupervisor) return;
      this.inFlight = true;
      try {
        const config = runtimeSupervisor.readConfig();
        const health = await runtimeSupervisor.proxyHealthPayload(config);
        if (!Number.isInteger(health?.successful_model_catalog_requests)
          || health.successful_model_catalog_requests < 1) {
          const result = health?.last_model_catalog_result;
          if (!result || !Number.isInteger(result.status) || result.status < 400 || result.status > 599
            || !Number.isInteger(result.request) || result.request < 1
            || this.getLastOperation()?.status === "running") {
            return;
          }
          const identity = `${health.pid}:${result.request}:${result.at}`;
          if (identity === reportedFailure) return;
          reportedFailure = identity;
          const reason = typeof result.failure?.code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(result.failure.code)
            ? result.failure.code
            : ["config", "request", "transport", "upstream", "catalog"].includes(result.failure?.stage)
              ? result.failure.stage
              : "catalog";
          const state = this.stateStore.update({ codexRestartRequired: false });
          this.send("launcher:state-changed", state);
          this.logger.warn("codex.model_catalog_failed", {
            status: result.status,
            reason,
            request: result.request,
          });
          this.publishOperation({
            name: "catalog-verification",
            status: "failed",
            message: nativeCopyFor(current.language).catalogFailure
              .replace("{status}", String(result.status))
              .replace("{reason}", reason),
          });
          return;
        }
        const state = this.stateStore.update({
          codexCatalogVerified: true,
          codexRestartRequired: false,
        });
        this.logger.info("codex.model_catalog_verified", {
          requests: health.successful_model_catalog_requests,
          at: health.last_successful_model_catalog_request_at,
        });
        this.send("launcher:state-changed", state);
        this.stop();
      } catch (error) {
        this.logger.debug("codex.model_catalog_verification_pending", {
          message: error instanceof Error ? error.message : String(error),
        });
      } finally {
        this.inFlight = false;
      }
    };
    this.timer = setInterval(() => { void check(); }, 2_000);
    this.timer.unref?.();
    void check();
  }

  async restoreCodexRouteAfterRuntimeFailure() {
    try {
      const runtimeHost = this.getRuntimeHost();
      const route = await runtimeHost.restoreBridgeRoute("runtime-start-fail-safe");
      if (!route.installed || route.active) return { restored: false };
      const state = this.stateStore.update({
        codexCatalogVerified: false,
        codexRestartRequired: true,
      });
      this.send("launcher:state-changed", state);
      this.stop();
      this.logger.warn("bridge.route_restored_after_runtime_failure", {
        changed: route.changed === true,
      });
      return { restored: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error("bridge.route_restore_after_runtime_failure_failed", { message });
      return { restored: false, error: message };
    }
  }
}

module.exports = { CatalogMonitor };

