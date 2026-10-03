/**
 * POST {prefix}/proxy/:method — the unary RPC surface of the frozen contract.
 *
 * Layering (contract-map §2/§3):
 *  1. auth (401, never with the DSH race hint string)
 *  2. envelope validation (carrier-level 400 on malformed)
 *  3. whitelist: outside → carrier-level 403 method_not_allowed;
 *     inside but not implemented in v1 → business error method_not_migrated
 *  4. engine dispatch — business outcomes always ride HTTP 200 + result.ok
 */
import type { FastifyInstance } from "fastify";
import type { FacadeConfig } from "../config.ts";
import { apiKeyOf, keyMatches } from "../auth.ts";
import { EngineError, type PiEngine } from "../engine.ts";
import { parseClientRequest, serverErr, serverOk, textOfContentBlocks } from "../wire.ts";

/** The manager's own whitelist (rpc.ts:24-40) — anything else never reaches the engine. */
const WHITELIST = new Set([
  "session.list",
  "session.create",
  "session.history",
  "session.prompt",
  "session.cancel",
  "session.rename",
  "session.fork",
  "session.updateQueue",
  "session.attachment",
  "session.models",
  "session.selectModel",
  "host.describe",
]);

/** Whitelisted but honestly unimplemented in v1 (contract-map §13). */
const NOT_MIGRATED = new Set(["session.rename", "session.fork", "session.updateQueue", "session.attachment"]);

const needStr = (payload: Record<string, unknown>, field: string): string => {
  const value = payload[field];
  if (typeof value !== "string" || value === "") {
    throw new EngineError("invalid_params", `${field} must be a non-empty string`);
  }
  return value;
};

const optionalStr = (payload: Record<string, unknown>, field: string): string | null => {
  const value = payload[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new EngineError("invalid_params", `${field} must be a string or null`);
  return value;
};

export const dispatchMethod = async (
  engine: PiEngine,
  method: string,
  payload: Record<string, unknown>,
): Promise<unknown> => {
  switch (method) {
    case "session.create": {
      const cwd = needStr(payload, "cwd");
      return engine.createSession(cwd, optionalStr(payload, "agentPreset"));
    }
    case "session.prompt": {
      const sessionId = needStr(payload, "sessionId");
      const text = textOfContentBlocks(payload["content"]);
      if (text === null) throw new EngineError("invalid_params", "content must be an array of {type:'text',text} blocks");
      return engine.prompt(sessionId, text);
    }
    case "session.cancel":
      await engine.cancel(needStr(payload, "sessionId"));
      return { cancelled: true };
    case "session.history":
      return engine.history(needStr(payload, "sessionId"));
    case "session.list":
      return { items: await engine.listSessions() };
    case "session.models":
      return engine.models();
    case "session.selectModel": {
      const sessionId = needStr(payload, "sessionId");
      const provider = needStr(payload, "provider");
      const model = needStr(payload, "model");
      const reasoningEffort = optionalStr(payload, "reasoningEffort");
      const selected = await engine.selectModel(sessionId, {
        provider,
        model,
        ...(reasoningEffort !== null ? { reasoningEffort } : {}),
      });
      return { selected };
    }
    case "host.describe":
      return engine.hostDescribe();
    default:
      throw new EngineError("method_not_migrated", `${method} is not implemented by pi-api-facade`);
  }
};

export const registerProxyRoutes = (
  app: FastifyInstance,
  config: FacadeConfig,
  engine: PiEngine,
): void => {
  app.post(`${config.prefix}/proxy/:method`, async (request, reply) => {
    if (!keyMatches(apiKeyOf(request.headers), config.apiKeys)) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const params = request.params as { method?: unknown };
    const method = typeof params.method === "string" ? params.method : "";
    const envelope = parseClientRequest(request.body);
    if (envelope === null || envelope.method !== method) {
      // The envelope method must match the path (manager rpc.ts module header).
      return reply.code(400).send({ error: "bad_request", detail: "malformed client-request envelope" });
    }

    if (!WHITELIST.has(method)) {
      return reply.code(403).send({ error: "method_not_allowed" });
    }
    if (NOT_MIGRATED.has(method)) {
      return reply.send(serverErr(envelope.rpcId, "method_not_migrated", `${method} is not implemented by pi-api-facade`));
    }

    try {
      const value = await dispatchMethod(engine, method, envelope.payload ?? {});
      return reply.send(serverOk(envelope.rpcId, value));
    } catch (error) {
      if (error instanceof EngineError) {
        return reply.send(serverErr(envelope.rpcId, error.code, error.message));
      }
      const message = error instanceof Error ? error.message : String(error);
      request.log.error({ err: error }, `proxy ${method} failed`);
      return reply.send(serverErr(envelope.rpcId, "internal_error", message));
    }
  });
};
