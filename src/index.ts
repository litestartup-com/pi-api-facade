/**
 * Process entrypoint: load config, select the engine, wire the mux hub and
 * the card table, start the HTTP listener, shut down gracefully on
 * SIGINT/SIGTERM so the DAC node supervisor can restart without orphans.
 */
import { loadConfig } from "./config.ts";
import { buildServer } from "./server.ts";
import type { PiEngine } from "./engine.ts";
import { FakePiEngine } from "./engine-fake.ts";
import { SdkPiEngine } from "./engine-sdk.ts";
import { MuxHub } from "./mux-hub.ts";
import { CardTable } from "./cards.ts";
import { commitWorkspace } from "./git-hook.ts";
import { applyOpenAiCompat } from "./openai-compat.ts";

const config = loadConfig();

/** Parses "provider/model" (PI_FACADE_MODEL); null when unset or malformed. */
const parseModel = (raw: string | undefined): { provider: string; model: string } | null => {
  if (raw === undefined || raw === "") return null;
  const slash = raw.indexOf("/");
  if (slash <= 0 || slash === raw.length - 1) {
    console.error(`PI_FACADE_MODEL must look like "provider/model", got: ${raw}`);
    process.exit(1);
  }
  return { provider: raw.slice(0, slash), model: raw.slice(slash + 1) };
};

const hub = new MuxHub();
const cards = new CardTable((payload, rpcId) => hub.broadcast(payload, rpcId));

const engineMode = process.env["PI_FACADE_ENGINE"] ?? "";
let engine: PiEngine;
if (engineMode === "sdk") {
  if (config.openaiCompat !== null) {
    const compat = applyOpenAiCompat(config.agentDir, config.openaiCompat);
    console.log(`openai-compat: ${compat.note}`);
  }
  const defaultModel = parseModel(process.env["PI_FACADE_MODEL"]) ?? { provider: "deepseek", model: "deepseek-flash" };
  engine = new SdkPiEngine({
    agentDir: config.agentDir,
    allowFullAccess: config.allowFullAccess,
    defaultModel,
    approvalGate: (request) => cards.requestApproval(request),
    questionGate: (request) => cards.requestQuestion(request),
    onRunSettled: ({ sessionId, cwd }) => {
      commitWorkspace(cwd, sessionId).catch((error: unknown) => {
        console.error("git-hook failed:", error);
      });
    },
  });
  console.log(`engine: pi-sdk (default model ${defaultModel.provider}/${defaultModel.model})`);
} else if (engineMode === "fake") {
  console.warn("WARNING: PI_FACADE_ENGINE=fake — in-memory development engine, NOT a real Pi node");
  engine = new FakePiEngine({ version: "pi-fake", allowFullAccess: config.allowFullAccess });
} else {
  console.error("PI_FACADE_ENGINE must be 'sdk' (production) or 'fake' (development); refusing to boot.");
  process.exit(1);
}

hub.tapEngine((listener) => engine.subscribeAll(listener));

const app = await buildServer(config, engine, { hub, cards });

await app.listen({ port: config.port, host: config.host });
// Print the CONFIGURED bind address: fastify renders a wildcard (0.0.0.0) bind
// as "http://127.0.0.1:<port>", which reads like a loopback-only listener in
// container logs and misleads exactly when reachability matters.
console.log(`pi-api-facade listening on ${config.host}:${config.port} (prefix ${config.prefix}, agentDir ${config.agentDir})`);
if (config.apiKeys.length === 0) {
  console.warn("WARNING: PI_FACADE_API_KEYS is empty — every authenticated call will be rejected (fail closed)");
}

let shuttingDown = false;
const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    console.error("shutdown failed:", error);
    process.exit(1);
  }
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
