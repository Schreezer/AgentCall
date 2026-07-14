export class CallWorker {
  constructor(store, apns, { intervalMs = 1000, logger = console } = {}) {
    this.store = store;
    this.apns = apns;
    this.intervalMs = intervalMs;
    this.logger = logger;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  async tick(now = new Date()) {
    if (this.running) return;
    this.running = true;
    try {
      for (const call of this.store.dueCalls(now)) {
        this.store.updateCall(call.id, { status: "delivering" });
        const devices = this.store.getDevicesForInstallation(call.installationID);
        const results = await Promise.allSettled(devices.map((device) => this.apns.sendVoIP(device, call)));
        const errors = results
          .filter((result) => result.status === "rejected")
          .map((result) => result.reason?.message ?? String(result.reason));
        const delivered = devices.length > 0 && errors.length < devices.length;
        this.store.updateCall(call.id, {
          status: delivered ? "delivered" : "failed",
          deliveredAt: delivered ? new Date().toISOString() : null,
          deliveryErrors: devices.length ? errors : ["No registered devices"],
        });
      }
    } catch (error) {
      this.logger.error("Call worker failed", error);
    } finally {
      this.running = false;
    }
  }
}
