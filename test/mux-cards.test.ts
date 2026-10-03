/**
 * F4 gate: events.mux WebSocket + respond + card recovery, asserted with a
 * real WebSocket client against the fake engine (no Pi, no network).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { loadConfig } from "../src/config.ts";
import { buildServer } from "../src/server.ts";
import { FakePiEngine } from "../src/engine-fake.ts";
import { MuxHub } from "../src/mux-hub.ts";
import { CardTable } from "../src/cards.ts";
import type { FastifyInstance } from "fastify";

const KEY = "***";
const config = loadConfig({ PI_FACADE_API_KEYS: KEY, PI_FACADE_PORT: "0" });
const engine = new FakePiEngine({ version: "pi-fake", allowFullAccess: true });
const hub = new MuxHub();
const cards = new CardTable((payload, rpcId) => hub.broadcast(payload, rpcId));
hub.tapEngine((listener) => engine.subscribeAll(listener));

let app: FastifyInstance;
let base: string;
let wsBase: string;

interface Envelope {
  type: string;
  rpcId: string;
  method: string;
  payload: Record<string, unknown>;
}

const connect = async (withKey = true): Promise<{ ws: WebSocket; envelopes: Envelope[]; closed: Promise<{ code: number }> }> => {
  const ws = new WebSocket(`${wsBase}/events.mux`, withKey ? { headers: { "x-api-key": KEY } } : undefined);
  const envelopes: Envelope[] = [];
  ws.on("message", (data) => {
    envelopes.push(JSON.parse(String(data)) as Envelope);
  });
  const closed = new Promise<{ code: number }>((resolve) => {
    ws.on("close", (code) => resolve({ code }));
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`handshake ${res.statusCode}`)));
    ws.once("error", reject);
  });
  return { ws, envelopes, closed };
};

const waitFor = async (
  envelopes: Envelope[],
  predicate: (env: Envelope) => boolean,
  timeoutMs = 5_000,
): Promise<Envelope> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = envelopes.find(predicate);
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for frame; got ${JSON.stringify(envelopes.map((e) => e.method))}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

before(async () => {
  app = await buildServer(config, engine, { hub, cards });
  base = await app.listen({ port: 0, host: "127.0.0.1" });
  wsBase = base.replace(/^http/, "ws") + config.prefix + "/proxy";
});

after(async () => {
  await app.close();
});

test("mux handshake rejects a missing key with 401 (never upgrades)", async () => {
  const ws = new WebSocket(`${wsBase}/events.mux`);
  const status = await new Promise<number>((resolve) => {
    ws.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
    ws.once("error", () => resolve(0));
  });
  assert.equal(status, 401);
  ws.close();
});

test("engine frames arrive as server-request envelopes with method = payload.type", async () => {
  const { ws, envelopes } = await connect();
  const created = await engine.createSession("/tmp/ws-mux");
  await engine.prompt(created.sessionId, "hello mux");
  const turnEnd = await waitFor(envelopes, (e) => e.payload["type"] === "session/event" &&
    (e.payload["event"] as { type?: string })?.type === "turn/end");
  assert.equal(turnEnd.type, "server-request");
  assert.equal(turnEnd.method, "session/event");
  const types = envelopes
    .filter((e) => e.method === "session/event")
    .map((e) => (e.payload["event"] as { type: string }).type);
  assert.deepEqual(types, ["user/message", "turn/start", "assistant/message", "turn/end"]);
  assert.ok(envelopes.every((e) => e.payload["sessionId"] === created.sessionId));
  ws.close();
});

test("mux is downstream-only: a client frame closes the socket with 1008", async () => {
  const { ws, closed } = await connect();
  ws.send("client frames are not a thing");
  const { code } = await closed;
  assert.equal(code, 1008);
});

test("card chain: request → broadcast → pending recovery → respond → gate resolves → resolved frame", async () => {
  const { ws, envelopes } = await connect();

  const gate = cards.requestApproval({
    sessionId: "s-card",
    approvalId: "ap-1",
    toolName: "bash",
    callId: "call-1",
    reason: '{"command":"rm -rf /tmp/build"}',
  });

  const requested = await waitFor(envelopes, (e) => e.method === "approval/requested");
  assert.equal(requested.type, "server-request");
  assert.ok(requested.rpcId.startsWith("fac-"), "the envelope carries the respond rpcId");
  assert.equal(requested.payload["toolName"], "bash");
  assert.equal(requested.payload["sessionId"], "s-card");

  // recovery surface: the pending card is listed verbatim
  const pendingRes = await fetch(`${base}${config.prefix}/answerer/pending`, { headers: { "x-api-key": KEY } });
  assert.equal(pendingRes.status, 200);
  const pendingBody = (await pendingRes.json()) as { pending: Array<{ rpcId: string; method: string; payload: Record<string, unknown> }> };
  assert.equal(pendingBody.pending.length, 1);
  assert.equal(pendingBody.pending[0]!.rpcId, requested.rpcId);
  assert.equal(pendingBody.pending[0]!.method, "approval/requested");
  assert.deepEqual(pendingBody.pending[0]!.payload, requested.payload);

  const respond = async (result: unknown): Promise<unknown> => {
    const res = await fetch(`${base}${config.prefix}/proxy/respond`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({ type: "client-response", rpcId: requested.rpcId, result }),
    });
    assert.equal(res.status, 200);
    return res.json();
  };

  // wrong sessionId → not-pending (never resolve on a mismatch)
  assert.deepEqual(await respond({ ok: true, value: { sessionId: "other", approvalId: "ap-1", outcome: "allowed-once" } }), {
    accepted: false,
    reason: "not-pending",
  });
  // unknown outcome vocabulary → bad-response
  assert.deepEqual(await respond({ ok: true, value: { sessionId: "s-card", approvalId: "ap-1", outcome: "allow-forever" } }), {
    accepted: false,
    reason: "bad-response",
  });
  // not-ok that is not a cancel → bad-response
  assert.deepEqual(await respond({ ok: false, error: { code: "weird", message: "x" } }), {
    accepted: false,
    reason: "bad-response",
  });
  // the real decision
  assert.deepEqual(await respond({ ok: true, value: { sessionId: "s-card", approvalId: "ap-1", outcome: "allowed-once" } }), {
    accepted: true,
  });
  assert.equal(await gate, "allowed-once");

  const resolved = await waitFor(envelopes, (e) => e.method === "approval/resolved");
  assert.equal(resolved.payload["approvalId"], "ap-1");
  assert.equal(resolved.payload["outcome"], "allowed-once");

  // a replay of the same rpcId is not-pending (the card is gone)
  assert.deepEqual(await respond({ ok: true, value: { sessionId: "s-card", approvalId: "ap-1", outcome: "rejected" } }), {
    accepted: false,
    reason: "not-pending",
  });
  ws.close();
});

test("respond for an unknown rpcId is not-pending; envelopes must be client-response", async () => {
  const res = await fetch(`${base}${config.prefix}/respond`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY },
    body: JSON.stringify({ type: "client-response", rpcId: "never-minted", result: { ok: true, value: { sessionId: "s", approvalId: "a", outcome: "rejected" } } }),
  });
  assert.deepEqual(await res.json(), { accepted: false, reason: "not-pending" });

  const bad = await fetch(`${base}${config.prefix}/respond`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY },
    body: JSON.stringify({ type: "nonsense" }),
  });
  assert.equal(bad.status, 400);
});

test("approval vocabulary: cancelled and unavailable are accepted outcomes (D0 finding G3)", async () => {
  // The DSH host accepts allowed-once | rejected | cancelled | unavailable
  // (facade-client.mjs documents the four; 'unavailable' is the fail-closed
  // headless outcome). Anything but allowed-once must block the tool.
  for (const outcome of ["cancelled", "unavailable"]) {
    const gate = cards.requestApproval({
      sessionId: `s-${outcome}`,
      approvalId: `ap-${outcome}`,
      toolName: "bash",
      callId: null,
      reason: null,
    });
    // Find the minted rpcId through the recovery surface.
    let rpcId = "";
    for (let i = 0; i < 50 && rpcId === ""; i++) {
      const listRes = await fetch(`${base}${config.prefix}/answerer/pending`, { headers: { "x-api-key": KEY } });
      const body = (await listRes.json()) as { pending: Array<{ rpcId: string; payload: { sessionId?: string } }> };
      rpcId = body.pending.find((p) => p.payload["sessionId"] === `s-${outcome}`)?.rpcId ?? "";
      if (rpcId === "") await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(rpcId !== "", `card for ${outcome} is recoverable`);
    const res = await fetch(`${base}${config.prefix}/respond`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({ type: "client-response", rpcId, result: { ok: true, value: { sessionId: `s-${outcome}`, approvalId: `ap-${outcome}`, outcome } } }),
    });
    assert.deepEqual(await res.json(), { accepted: true }, `${outcome} is a valid outcome`);
    assert.equal(await gate, outcome, `the gate resolves as ${outcome} (blocking)`);
  }
});

test("card TTL expiry resolves the gate as expired and broadcasts the resolved frame", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const shortTable = new CardTable((payload) => seen.push(payload as unknown as Record<string, unknown>), 60);
  const outcome = await shortTable.requestApproval({
    sessionId: "s-ttl",
    approvalId: "ap-ttl",
    toolName: "bash",
    callId: null,
    reason: null,
  });
  assert.equal(outcome, "expired");
  const resolved = seen.find((p) => p["type"] === "approval/resolved");
  assert.ok(resolved);
  assert.equal(resolved["outcome"], "expired");
  assert.equal(shortTable.size, 0);
});

// ---- question cards (D3: the ask_user bridge) ----

const respondVia = async (rpcId: string, result: unknown): Promise<unknown> => {
  const res = await fetch(`${base}${config.prefix}/respond`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY },
    body: JSON.stringify({ type: "client-response", rpcId, result }),
  });
  assert.equal(res.status, 200);
  return res.json();
};

test("question card: minted, recoverable, answered — gate resolves with the answers", async () => {
  const gate = cards.requestQuestion({
    sessionId: "s-q1",
    questions: [{ id: "q1", question: "Which option?", options: [{ label: "A" }, { label: "B" }] }],
  });
  // recoverable through answerer/pending with method question/requested
  let entry: { rpcId: string; method: string; payload: Record<string, unknown> } | undefined;
  for (let i = 0; i < 50 && entry === undefined; i++) {
    const res = await fetch(`${base}${config.prefix}/answerer/pending`, { headers: { "x-api-key": KEY } });
    const body = (await res.json()) as { pending: Array<{ rpcId: string; method: string; payload: Record<string, unknown> }> };
    entry = body.pending.find((p) => p.payload["sessionId"] === "s-q1");
    if (entry === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(entry, "the question card is listed for recovery");
  assert.equal(entry.method, "question/requested");
  assert.deepEqual(entry.payload["questions"], [{ id: "q1", question: "Which option?", options: [{ label: "A" }, { label: "B" }] }]);

  // wrong session → not-pending
  assert.deepEqual(await respondVia(entry.rpcId, { ok: true, value: { sessionId: "other", answer: { answers: [] } } }), {
    accepted: false,
    reason: "not-pending",
  });
  // malformed answer → bad-response
  assert.deepEqual(await respondVia(entry.rpcId, { ok: true, value: { sessionId: "s-q1" } }), {
    accepted: false,
    reason: "bad-response",
  });
  // the real answer
  assert.deepEqual(
    await respondVia(entry.rpcId, { ok: true, value: { sessionId: "s-q1", answer: { answers: [{ id: "q1", selected: ["B"] }] } } }),
    { accepted: true },
  );
  assert.deepEqual(await gate, { cancelled: false, answers: [{ id: "q1", selected: ["B"] }] });
});

test("question card: decline (cancelled) resolves as cancelled", async () => {
  const gate = cards.requestQuestion({ sessionId: "s-q2", questions: [{ id: "q1", question: "Continue?" }] });
  const rpcId = cards.pendingList().find((p) => p.payload["sessionId"] === "s-q2")!.rpcId;
  assert.deepEqual(
    await respondVia(rpcId, { ok: false, error: { code: "cancelled", message: "the user cancelled ask_user_question" } }),
    { accepted: true },
  );
  assert.deepEqual(await gate, { cancelled: true, outcome: "cancelled" });
});

test("question card: TTL expiry resolves as cancelled/expired and broadcasts question/resolved", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const shortTable = new CardTable((payload) => seen.push(payload as unknown as Record<string, unknown>), 60);
  const resolution = await shortTable.requestQuestion({ sessionId: "s-q3", questions: [{ id: "q1", question: "Q?" }] });
  assert.deepEqual(resolution, { cancelled: true, outcome: "expired" });
  const resolved = seen.find((p) => p["type"] === "question/resolved");
  assert.ok(resolved, "a question/resolved frame is broadcast on expiry");
  assert.equal(resolved["outcome"], "expired");
  assert.equal(shortTable.size, 0);
});

test("sandbox-mode: live pin, cold 409, bad mode 400, auth 401", async () => {
  const created = await engine.createSession("/tmp/ws-sandbox");
  const url = `${base}${config.prefix}/sessions/${created.sessionId}/sandbox-mode`;

  const noAuth = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: '{"mode":"read-only"}' });
  assert.equal(noAuth.status, 401);

  const bad = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-api-key": KEY }, body: '{"mode":"yolo"}' });
  assert.equal(bad.status, 400);

  const ok = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-api-key": KEY }, body: '{"mode":"danger-full-access"}' });
  assert.equal(ok.status, 200);
  const history = await engine.history(created.sessionId);
  assert.deepEqual(history.projections.values["permissions"], { currentValue: "danger-full-access" });

  const cold = await fetch(`${base}${config.prefix}/sessions/does-not-exist/sandbox-mode`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY },
    body: '{"mode":"read-only"}',
  });
  assert.equal(cold.status, 409);
});
