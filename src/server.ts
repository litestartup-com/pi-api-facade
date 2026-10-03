/**
 * Fastify application factory. Routes are mounted under the configured prefix
 * so the manager's endpoint wiring (url + prefix) matches the dsh-api-gateway
 * shape exactly (docs/contract-map.md §1).
 *
 * Service surfaces:
 *  - {prefix}/health                     (no auth)
 *  - {prefix}/key                        (permanently closed; env-provisioned keys)
 *  - {prefix}/proxy/:method              (RPC envelope; whitelist fail-closed)
 *  - {prefix}/respond + proxy/respond    (card receipts via the CardTable)
 *  - {prefix}/answerer/pending           (card recovery)
 *  - {prefix}/sessions/:id/sandbox-mode  (live-session tier pin)
 *  - {prefix}/proxy/events.mux (+ alias) (downstream-only WebSocket broadcast)
 */
import { readFileSync } from "node:fs";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import websocketPlugin from "@fastify/websocket";
import type { FacadeConfig } from "./config.ts";
import { EngineError, type PiEngine, type SandboxMode } from "./engine.ts";
import { apiKeyOf, keyMatches } from "./auth.ts";
import { registerProxyRoutes } from "./routes/proxy.ts";
import type { CardTable } from "./cards.ts";
import type { MuxHub, MuxSocket } from "./mux-hub.ts";

const pkg = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

export const serviceVersion: string = pkg.version;

export interface FacadeServices {
  hub?: MuxHub;
  cards?: CardTable;
}

const SANDBOX_MODES = new Set<SandboxMode>(["read-only", "workspace-write", "danger-full-access"]);

export const buildServer = async (config: FacadeConfig, engine: PiEngine, services: FacadeServices = {}): Promise<FastifyInstance> => {
  const app = Fastify({ logger: false });
  await app.register(websocketPlugin);

  const authorized = (request: FastifyRequest): boolean => keyMatches(apiKeyOf(request.headers), config.apiKeys);
  const unauthorized = (reply: FastifyReply): FastifyReply =>
    // Never include the DSH race hint string; the manager would retry on it.
    reply.code(401).send({ error: "unauthorized" });

  // Unauthenticated liveness probe (contract: GET {prefix}/health).
  // `status`/`upstream` mirror the dsh-api-gateway health shape that demo BFFs
  // render ("${status}/${upstream}"); ok/service/version are this facade's own.
  app.get(`${config.prefix}/health`, async () => ({
    ok: true,
    status: "ok",
    service: "pi-api-facade",
    version: serviceVersion,
    upstream: engine.hostDescribe().version,
  }));

  // Self-provisioning is permanently closed: keys are environment-provisioned.
  app.post(`${config.prefix}/key`, async (_request, reply) =>
    reply.code(409).send({
      error: "provisioning_disabled",
      message: "pi-api-facade keys are environment-provisioned; self-provisioning is permanently closed",
    }),
  );

  // ---- respond (card receipts) ----
  const respondHandler = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    if (!authorized(request)) return unauthorized(reply);
    const body = request.body;
    if (body === null || typeof body !== "object") return reply.code(400).send({ error: "bad_request" });
    const envelope = body as Record<string, unknown>;
    if (envelope["type"] !== "client-response" || typeof envelope["rpcId"] !== "string") {
      return reply.code(400).send({ error: "bad_request", detail: "expected a client-response envelope" });
    }
    const result = envelope["result"];
    if (result === null || typeof result !== "object") {
      return reply.send({ accepted: false, reason: "bad-response" });
    }
    const cards = services.cards;
    if (cards === undefined) {
      // No card table wired (unit-test builds): nothing can be pending, honestly.
      return reply.send({ accepted: false, reason: "not-pending" });
    }
    const receipt = cards.respond(envelope["rpcId"], result as Parameters<CardTable["respond"]>[1]);
    return reply.send(receipt);
  };
  app.post(`${config.prefix}/respond`, respondHandler);
  app.post(`${config.prefix}/proxy/respond`, respondHandler);

  // ---- card recovery ----
  app.get(`${config.prefix}/answerer/pending`, async (request, reply) => {
    if (!authorized(request)) return unauthorized(reply);
    return { pending: services.cards?.pendingList() ?? [] };
  });

  // ---- per-session sandbox tier ----
  app.post(`${config.prefix}/sessions/:id/sandbox-mode`, async (request, reply) => {
    if (!authorized(request)) return unauthorized(reply);
    const params = request.params as { id?: unknown };
    const sessionId = typeof params.id === "string" ? params.id : "";
    const body = recOf(request.body);
    const mode = body?.["mode"];
    if (sessionId === "" || typeof mode !== "string" || !SANDBOX_MODES.has(mode as SandboxMode)) {
      return reply.code(400).send({ error: "bad_request", detail: "expected {mode: read-only|workspace-write|danger-full-access}" });
    }
    try {
      await engine.setSandboxMode(sessionId, mode as SandboxMode);
      return reply.send({ ok: true, sessionId, mode });
    } catch (error) {
      if (error instanceof EngineError && error.code === "session_not_live") {
        return reply.code(409).send({ error: "session_not_live" });
      }
      if (error instanceof EngineError && error.code === "full_access_locked") {
        return reply.code(403).send({ error: "full_access_locked", detail: error.message });
      }
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(500).send({ error: "sandbox_mode_failed", detail: message });
    }
  });

  // ---- events.mux (downstream-only broadcast) ----
  const muxRoute = (socket: MuxSocket): void => {
    services.hub?.add(socket);
    socket.on("message", () => {
      // The mux pipe is downstream read-only: any client frame closes 1008.
      try {
        socket.close(1008, "downstream only");
      } catch {
        /* already closing */
      }
    });
    socket.on("close", () => services.hub?.remove(socket));
    socket.on("error", () => services.hub?.remove(socket));
  };
  const muxPreHandler = (request: FastifyRequest, reply: FastifyReply, done: (error?: Error) => void): void => {
    if (!authorized(request)) {
      reply.code(401).send({ error: "unauthorized" });
      return;
    }
    done();
  };
  const muxOptions = { websocket: true, preHandler: muxPreHandler };
  app.get(`${config.prefix}/proxy/events.mux`, muxOptions, (socket) => muxRoute(socket as unknown as MuxSocket));
  app.get(`${config.prefix}/events.mux`, muxOptions, (socket) => muxRoute(socket as unknown as MuxSocket));

  registerProxyRoutes(app, config, engine);

  return app;
};

const recOf = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
