/**
 * F3 integration gate: SdkPiEngine against a local stub OpenAI-compatible
 * provider (models.json custom provider → 127.0.0.1 SSE stub). Fully offline:
 * no real keys, no external network, deterministic frames.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { SdkPiEngine } from "../src/engine-sdk.ts";
import type { MuxPayload } from "../src/engine.ts";

// ---- stub provider (OpenAI chat-completions SSE) ----

interface StubState {
  port: number;
  requests: Array<{ url: string | undefined; body: Record<string, unknown> | null }>;
  close: () => Promise<void>;
}

const startStubProvider = async (): Promise<StubState> => {
  const requests: StubState["requests"] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      requests.push({ url: req.url, body: raw === "" ? null : (JSON.parse(raw) as Record<string, unknown>) });
      if (req.url !== undefined && req.url.endsWith("/chat/completions")) {
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "close",
        });
        const base = { id: "chatcmpl-stub", object: "chat.completion.chunk", created: 1790000000, model: "stub-model" };
        const chunk = (obj: unknown): void => {
          res.write(`data: ${JSON.stringify(obj)}\n\n`);
        };
        chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
        chunk({ ...base, choices: [{ index: 0, delta: { content: "PO" }, finish_reason: null }] });
        chunk({ ...base, choices: [{ index: 0, delta: { content: "NG" }, finish_reason: null }] });
        chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
        chunk({ ...base, choices: [], usage: { prompt_tokens: 453, completion_tokens: 2, total_tokens: 455 } });
        res.write("data: [DONE]\n\n");
        res.end();
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

// ---- harness ----

let stub: StubState;
let agentDir: string;
let workspace: string;
let engine: SdkPiEngine;

const collect = async (
  sessionId: string,
  trigger: () => Promise<unknown>,
  timeoutMs = 60_000,
): Promise<MuxPayload[]> => {
  const frames: MuxPayload[] = [];
  let done: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    done = resolve;
  });
  const unsubscribe = engine.subscribe(sessionId, (payload) => {
    frames.push(payload);
    if (payload.type === "session/event" && payload.event.type === "turn/end") done();
  });
  const timer = setTimeout(done, timeoutMs);
  await trigger();
  await finished;
  clearTimeout(timer);
  unsubscribe();
  return frames;
};

const eventFrames = (frames: MuxPayload[]): Array<{ type: string; data: Record<string, unknown> }> =>
  frames.flatMap((f) => (f.type === "session/event" ? [{ type: f.event.type, data: f.event.data }] : []));

before(async () => {
  process.env["PI_OFFLINE"] = "1";
  stub = await startStubProvider();
  agentDir = mkdtempSync(path.join(tmpdir(), "pi-facade-agent-"));
  workspace = mkdtempSync(path.join(tmpdir(), "pi-facade-ws-"));
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    path.join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        stub: {
          baseUrl: `http://127.0.0.1:${stub.port}/v1`,
          api: "openai-completions",
          apiKey: "stub-key",
          models: [
            {
              id: "stub-model",
              name: "Stub Model",
              input: ["text"],
              contextWindow: 32000,
              maxTokens: 4096,
              reasoning: false,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  engine = new SdkPiEngine({
    agentDir,
    allowFullAccess: false,
    defaultModel: { provider: "stub", model: "stub-model" },
    noTools: "all",
    allowModelNetwork: false,
  });
});

after(async () => {
  await stub.close();
});

test("create → prompt → frames: exact wire sequence with renamed usage (gate)", async () => {
  const created = await engine.createSession(workspace);
  assert.equal(created.provider, "stub");
  assert.equal(created.model, "stub-model");
  const frames = await collect(created.sessionId, () => engine.prompt(created.sessionId, "say pong"));
  const events = eventFrames(frames);
  assert.deepEqual(
    events.map((e) => e.type),
    ["turn/start", "user/message", "assistant/chunk", "assistant/chunk", "assistant/message", "turn/end"],
  );
  assert.deepEqual(events[2]!.data, { chunk: { type: "text-delta", text: "PO" } });
  assert.deepEqual(events[4]!.data, {
    message: { content: [{ type: "text", text: "PONG" }] },
    usage: { inputTokens: 453, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
  });
  assert.deepEqual(events[5]!.data, { turn: 1, reason: { kind: "completed" } });
  // every frame carries this session's id and nothing else
  assert.ok(frames.every((f) => f.sessionId === created.sessionId));
  // the stub really got a streaming chat-completions call for our model
  const completion = stub.requests.find((r) => r.url?.endsWith("/chat/completions"));
  assert.ok(completion);
  assert.equal(completion.body?.["stream"], true);
  assert.equal(completion.body?.["model"], "stub-model");
});

test("history replays the persisted tree in wire shapes (cold read)", async () => {
  const created = await engine.createSession(workspace);
  await collect(created.sessionId, () => engine.prompt(created.sessionId, "say pong"));
  const history = await engine.history(created.sessionId);
  assert.equal(history.hasMore, false);
  assert.deepEqual(
    history.events.map((e) => e.event.type),
    ["user/message", "turn/start", "assistant/message", "turn/end"],
  );
  const assistant = history.events[2]!.event.data as { usage?: Record<string, unknown> };
  assert.equal(assistant.usage?.["inputTokens"], 453);
  const values = history.projections.values as Record<string, unknown>;
  assert.deepEqual(values["modelSelection"], { next: { provider: "stub", model: "stub-model" } });
  assert.deepEqual(values["permissions"], { currentValue: "workspace-write" });
});

test("two sessions run concurrently in one process without crossing frames", async () => {
  const a = await engine.createSession(workspace);
  const b = await engine.createSession(workspace);
  const [framesA, framesB] = await Promise.all([
    collect(a.sessionId, () => engine.prompt(a.sessionId, "alpha marker")),
    collect(b.sessionId, () => engine.prompt(b.sessionId, "beta marker")),
  ]);
  const usersA = eventFrames(framesA).filter((e) => e.type === "user/message");
  const usersB = eventFrames(framesB).filter((e) => e.type === "user/message");
  assert.equal(usersA.length, 1);
  assert.equal(usersB.length, 1);
  assert.ok(JSON.stringify(usersA[0]!.data).includes("alpha marker"));
  assert.ok(JSON.stringify(usersB[0]!.data).includes("beta marker"));
  assert.ok(framesA.every((f) => f.sessionId === a.sessionId));
  assert.ok(framesB.every((f) => f.sessionId === b.sessionId));
  assert.ok(eventFrames(framesA).some((e) => e.type === "turn/end"));
  assert.ok(eventFrames(framesB).some((e) => e.type === "turn/end"));
});

test("listSessions sees persisted sessions with running flags", async () => {
  const created = await engine.createSession(workspace);
  await collect(created.sessionId, () => engine.prompt(created.sessionId, "say pong"));
  const items = await engine.listSessions();
  const mine = items.find((i) => i.sessionId === created.sessionId);
  assert.ok(mine, "the live session appears in the list");
  assert.equal(mine.running, true);
  assert.equal(mine.blank, false);
  assert.ok((mine.updatedAt ?? 0) > 0);
});

test("models catalog maps the stub provider; selectModel rejects unknown models", async () => {
  const catalog = await engine.models();
  assert.equal(catalog.routable, true);
  assert.deepEqual(catalog.current, { provider: "stub", model: "stub-model" });
  const group = catalog.groups.find((g) => g.id === "stub");
  assert.ok(group);
  assert.deepEqual(group.models, [{ id: "stub-model", name: "Stub Model" }]);

  const created = await engine.createSession(workspace);
  await assert.rejects(
    () => engine.selectModel(created.sessionId, { provider: "stub", model: "nope" }),
    (error: unknown) => error instanceof Error && /unknown model/.test(error.message),
  );
});

test("prompt on an unknown session is a business error, cancel on cold is a safe no-op", async () => {
  await assert.rejects(
    () => engine.prompt("does-not-exist", "hi"),
    (error: unknown) => error instanceof Error && /unknown session/.test(error.message),
  );
  await engine.cancel("does-not-exist"); // must not throw
});

test("cold resume: release then prompt reopens the persisted session and continues", async () => {
  const created = await engine.createSession(workspace);
  await collect(created.sessionId, () => engine.prompt(created.sessionId, "first"));
  await engine.release(created.sessionId);
  const frames = await collect(created.sessionId, () => engine.prompt(created.sessionId, "second"));
  const events = eventFrames(frames);
  assert.ok(events.some((e) => e.type === "turn/end"), "the resumed run completes");
  const history = await engine.history(created.sessionId);
  const users = history.events.filter((e) => e.event.type === "user/message");
  assert.equal(users.length, 2, "both prompts persisted across the release/reopen cycle");
});

test("concurrent prompts on a cold session attach exactly once (no double AgentSession on one file)", async () => {
  const created = await engine.createSession(workspace);
  await collect(created.sessionId, () => engine.prompt(created.sessionId, "warm-up"));
  await engine.release(created.sessionId);

  // Two prompts racing the cold-resume path: the second must ride the first
  // one's attach (in-flight memo), never open a second writer on the JSONL file.
  const [r1, r2] = await Promise.all([
    engine.prompt(created.sessionId, "racer-one"),
    engine.prompt(created.sessionId, "racer-two"),
  ]);
  assert.deepEqual(r1, { accepted: true });
  assert.deepEqual(r2, { accepted: true });

  // Wait for both user messages to persist (settled-frame count varies with
  // Pi's queueing, so history is the stable completion signal).
  const countUsers = async (): Promise<number> => {
    const history = await engine.history(created.sessionId);
    return history.events.filter((e) => e.event.type === "user/message").length;
  };
  const deadline = Date.now() + 60_000;
  let users = await countUsers();
  while (users < 3 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    users = await countUsers();
  }
  assert.equal(users, 3, "warm-up + both racers persisted");

  const items = (await engine.listSessions()).filter((i) => i.sessionId === created.sessionId);
  assert.equal(items.length, 1, "exactly one persisted session — no duplicate attach");
  await engine.release(created.sessionId);
});

test("hostDescribe reports the pi runtime and the pinned SDK version", () => {
  const host = engine.hostDescribe();
  assert.equal(host.runtime, "pi");
  assert.equal(host.protocol, "0.0.1");
  assert.match(host.version, /^pi-\d+\.\d+\.\d+/);
  assert.equal(host.allowFullAccess, false);
});
