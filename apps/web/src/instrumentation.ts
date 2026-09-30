/** Server start-up hook: error reporting with PHI scrubbing (see @dentosim/server telemetry). */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initTelemetry } = await import("@dentosim/server");
    initTelemetry("web");
  }
}
