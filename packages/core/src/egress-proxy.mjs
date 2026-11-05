// Entry point for the egress allowlist proxy sidecar (containment design section 5.2).
// Baked into the build image next to egress-proxy.ts and run as `node egress-proxy.mjs`.
// Node strips the TypeScript types itself (the source uses erasable syntax only), so there is no build step.
//
// Config, all from the environment:
//   ARGUS_EGRESS_ALLOW  comma-separated exact host:443 entries (required), e.g. api.anthropic.com:443,registry.npmjs.org:443
//   ARGUS_EGRESS_PORT   listen port, default 3128 (0 picks a free port; the "listening" line reports it)
//   ARGUS_EGRESS_HOST   listen address, default 0.0.0.0
// Events are JSON lines on stdout. The first is {"event":"listening",...}, which the worker waits for.
import { startEgressProxy } from "./egress-proxy.ts";

try {
  const allow = (process.env.ARGUS_EGRESS_ALLOW ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const rawPort = process.env.ARGUS_EGRESS_PORT ?? "3128";
  if (!/^[0-9]{1,5}$/.test(rawPort) || Number(rawPort) > 65535) throw new Error(`invalid ARGUS_EGRESS_PORT ${JSON.stringify(rawPort)}`);
  const proxy = await startEgressProxy({ allow, port: Number(rawPort), host: process.env.ARGUS_EGRESS_HOST || "0.0.0.0" });
  const stop = () => void proxy.close().then(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
} catch (err) {
  console.error(`egress-proxy: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
