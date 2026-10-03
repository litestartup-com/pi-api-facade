/**
 * F2 gate: the HTTP contract core, asserted from the manager's perspective
 * (docs/contract-map.md). Uses fastify inject + FakePiEngine — no ports, no
 * Pi SDK, no network.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { loadConfig, type FacadeConfig } from "../src/config.ts";
import { buildServer } from "../src/server.ts";
import { FakePiEngine } from "../src/engine-fake.ts";
import type { FastifyInstance } from "fastify";

const KEY = "***";
const config: FacadeConfig = loadConfig({ PI_FACADE_API_KEYS: KEY });
const app: FastifyInstance = await buildServer(config, new FakePiEngine({ version: "pi-fake" }));

before(() => app.ready());
after(async () => {
  await app.close();
});

interface RpcReply {
  type: string;
  rpcId?: string;
  result: { ok: boolean; value?: unknown; error?: { code: string; message: string } };
}

const call = async (
  method: string,
  payload: Record<string, unknown>,
  opts?: { key?: string | null; rawBody?: string },
): Promise<{ status: number; body: unknown }> => {
  const res = await app.inject({
    method: "POST",
    url: `${config.prefix}/proxy/${method}`,
    headers: {
      "content-type": "application/json",
      ...(opts?.key === null ? {} : { "x-api-key": opts?.key ?? KEY }),
    },
    body: opts?.rawBody ?? JSON.stringify({ type: "client-request", rpcId: `t-${method}`, method, payload }),
  });
  return { status: res.statusCode, body: res.json() as unknown };
};

test("auth: missing key is 401 and the body never carries the DSH race hint", async () => {
  const res = await call("session.list", {}, { key: null });
  assert.equal(res.status, 401);
  assert.ok(!JSON.stringify(res.body).includes("provisions a key"));
});

test("auth: wrong key is 401", async () => {
  const res = await call("session.list", {}, { key: "wrong" });
  assert.equal(res.status, 401);
});

test("auth: no configured keys rejects everything (fail closed)", async () => {
  const locked = await buildServer(loadConfig({}), new FakePiEngine());
  await locked.ready();
  const res = await locked.inject({
    method: "POST",
    url: "/api-gw/v1/proxy/session.list",
    headers: { "content-type": "application/json", "x-api-key": "anything" },
    body: JSON.stringify({ type: "client-request", rpcId: "t", method: "session.list", payload: {} }),
  });
  assert.equal(res.statusCode, 401);
  await locked.close();
});

test("whitelist: a method outside the manager whitelist is carrier-level 403", async () => {
  const res = await call("credentials.list", {});
  assert.equal(res.status, 403);
  assert.deepEqual(res.body, { error: "method_not_allowed" });
});

test("envelope: malformed body is carrier-level 400, not a guessed business error", async () => {
  const res = await call("session.list", {}, { rawBody: JSON.stringify({ type: "nonsense" }) });
  assert.equal(res.status, 400);
});

test("envelope: method/path mismatch is 400 (the envelope method must match the path)", async () => {
  const res = await call("session.list", {}, {
    rawBody: JSON.stringify({ type: "client-request", rpcId: "t", method: "session.create", payload: {} }),
  });
  assert.equal(res.status, 400);
});

test("session.create returns the created-session value shape", async () => {
  const res = await call("session.create", { cwd: "/tmp/ws" });
  assert.equal(res.status, 200);
  const body = res.body as RpcReply;
  assert.equal(body.type, "server-response");
  assert.equal(body.rpcId, "t-session.create");
  assert.equal(body.result.ok, true);
  const value = body.result.value as Record<string, unknown>;
  assert.equal(typeof value["sessionId"], "string");
  assert.equal(value["provider"], "deepseek");
  assert.equal(value["model"], "deepseek-flash");
});

test("session.create without cwd is a business error (HTTP stays 200)", async () => {
  const res = await call("session.create", {});
  assert.equal(res.status, 200);
  const body = res.body as RpcReply;
  assert.equal(body.result.ok, false);
  assert.equal(body.result.error?.code, "invalid_params");
});

test("prompt → history → list roundtrip on the fake engine", async () => {
  const created = (await call("session.create", { cwd: "/tmp/ws" })).body as RpcReply;
  const sessionId = (created.result.value as { sessionId: string }).sessionId;

  const prompted = (await call("session.prompt", {
    sessionId,
    mode: "queue",
    content: [{ type: "text", text: "hello" }],
  })).body as RpcReply;
  assert.deepEqual(prompted.result.value, { accepted: true });

  const history = (await call("session.history", { sessionId })).body as RpcReply;
  const hv = history.result.value as { events: Array<{ event: { type: string } }>; hasMore: boolean };
  assert.equal(hv.hasMore, false);
  assert.deepEqual(
    hv.events.map((e) => e.event.type),
    ["user/message", "turn/start", "assistant/message", "turn/end"],
  );

  const list = (await call("session.list", {})).body as RpcReply;
  const items = (list.result.value as { items: Array<{ sessionId: string; running: boolean }> }).items;
  assert.ok(items.some((i) => i.sessionId === sessionId));
});

test("prompt on an unknown session is business error session_not_found", async () => {
  const res = await call("session.prompt", { sessionId: "nope", content: [{ type: "text", text: "x" }] });
  assert.equal(res.status, 200);
  const body = res.body as RpcReply;
  assert.equal(body.result.ok, false);
  assert.equal(body.result.error?.code, "session_not_found");
});

test("models + selectModel roundtrip; unknown model is a business error", async () => {
  const models = (await call("session.models", {})).body as RpcReply;
  const catalog = models.result.value as { groups: Array<{ id: string; models: Array<{ id: string }> }> };
  assert.equal(catalog.groups[0]?.id, "deepseek");

  const created = (await call("session.create", { cwd: "/tmp/ws" })).body as RpcReply;
  const sessionId = (created.result.value as { sessionId: string }).sessionId;
  const selected = (await call("session.selectModel", {
    sessionId, provider: "deepseek", model: "deepseek-v4-pro",
  })).body as RpcReply;
  assert.deepEqual(selected.result.value, { selected: { provider: "deepseek", model: "deepseek-v4-pro" } });

  const bad = (await call("session.selectModel", {
    sessionId, provider: "deepseek", model: "does-not-exist",
  })).body as RpcReply;
  assert.equal(bad.result.ok, false);
  assert.equal(bad.result.error?.code, "model_not_found");
});

test("host.describe exposes version + allowFullAccess (+ parity fields)", async () => {
  const res = (await call("host.describe", {})).body as RpcReply;
  const value = res.result.value as Record<string, unknown>;
  assert.equal(value["version"], "pi-fake");
  assert.equal(value["allowFullAccess"], false);
  assert.equal(value["protocol"], "0.0.1");
  assert.equal(value["runtime"], "pi");
});

test("whitelisted-but-unimplemented methods answer method_not_migrated honestly", async () => {
  for (const method of ["session.rename", "session.fork", "session.updateQueue", "session.attachment"]) {
    const res = await call(method, {});
    assert.equal(res.status, 200, method);
    const body = res.body as RpcReply;
    assert.equal(body.result.ok, false, method);
    assert.equal(body.result.error?.code, "method_not_migrated", method);
  }
});

test("respond (both paths) is auth-gated and honestly not-pending until F4", async () => {
  for (const url of [`${config.prefix}/respond`, `${config.prefix}/proxy/respond`]) {
    const unauthorized = await app.inject({ method: "POST", url, headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(unauthorized.statusCode, 401, url);
    const res = await app.inject({
      method: "POST",
      url,
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({ type: "client-response", rpcId: "x", result: { ok: true, value: {} } }),
    });
    assert.equal(res.statusCode, 200, url);
    assert.deepEqual(res.json(), { accepted: false, reason: "not-pending" }, url);
  }
});

test("POST {prefix}/key is permanently closed (keys are env-provisioned)", async () => {
  const res = await app.inject({ method: "POST", url: `${config.prefix}/key`, headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(res.statusCode, 409);
  assert.equal((res.json() as { error: string }).error, "provisioning_disabled");
});
