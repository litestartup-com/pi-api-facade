/**
 * D3 gate (facade level, offline): the ask_user bridge end to end over the
 * real wire. A scripted stub provider emits an ask_user tool call; the engine's
 * inline tool blocks on the CardTable; the test answers through POST /respond
 * like the manager/demo BFFs do; the run then completes with the answer in the
 * tool result. No question surface exists in Pi itself — this bridge is it.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocket } from "ws";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.ts";
import { buildServer } from "../src/server.ts";
import { SdkPiEngine } from "../src/engine-sdk.ts";
import { MuxHub } from "../src/mux-hub.ts";
import { CardTable } from "../src/cards.ts";

const KEY = "***";

type ScriptedResponse =
  | { kind: "toolcall"; id: string; name: string; args: string }
  | { kind: "text"; text: string };

const script: ScriptedResponse[] = [
  {
    kind: "toolcall",
    id: "call-ask-1",
    name: "ask_user",
    args: JSON.stringify({
      questions: [{ id: "q1", question: "Which option do you pick?", options: [{ label: "A" }, { label: "B" }] }],
    }),
  },
  { kind: "text", text: "The operator picked B." },
];
let scriptIndex = 0;

interface StubState {
  port: number;
  close: () => Promise<void>;
}

const startStub = async (): Promise<StubState> => {
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      if (req.url === undefined || !req.url.endsWith("/chat/completions")) {
        res.writeHead(404);
        res.end("{}");
        return;
      }
      const entry = script[scriptIndex++];
      assert.ok(entry, "stub script exhausted");
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
      const base = { id: "chatcmpl-stub", object: "chat.completion.chunk", created: 1790000000, model: "stub-model" };
      const chunk = (obj: unknown): void => {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      };
      if (entry.kind === "toolcall") {
        chunk({
          ...base,
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: null,
                tool_calls: [{ index: 0, id: entry.id, type: "function", function: { name: entry.name, arguments: entry.args } }],
              },
              finish_reason: null,
            },
          ],
        });
        chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else {
        chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: entry.text }, finish_reason: null }] });
        chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      }
      chunk({ ...base, choices: [], usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

let stub: StubState;
let app: FastifyInstance;
let httpBase: string;

before(async () => {
  process.env["PI_OFFLINE"] = "1";
  stub = await startStub();
  const agentDir = mkdtempSync(path.join(tmpdir(), "pi-facade-ask-"));
  const workspace = mkdtempSync(path.join(tmpdir(), "pi-facade-ask-ws-"));
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

  const hub = new MuxHub();
  const cards = new CardTable((payload, rpcId) => hub.broadcast(payload, rpcId));
  const engine = new SdkPiEngine({
    agentDir,
    allowFullAccess: false,
    defaultModel: { provider: "stub", model: "stub-model" },
    allowModelNetwork: false,
    questionGate: (request) => cards.requestQuestion(request),
  });
  hub.tapEngine((listener) => engine.subscribeAll(listener));

  app = await buildServer(loadConfig({ PI_FACADE_API_KEYS: KEY }), engine, { hub, cards });
  httpBase = await app.listen({ port: 0, host: "127.0.0.1" });
  void workspace;
});

after(async () => {
  await app.close();
  await stub.close();
});

test("ask_user round trip: tool call → question/requested frame → respond → answer in tool result → run completes", async () => {
  const rpc = async (method: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const res = await fetch(`${httpBase}/api-gw/v1/proxy/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY },
      body: JSON.stringify({ type: "client-request", rpcId: `qb-${method}`, method, payload }),
    });
    const body = (await res.json()) as { result: { ok: boolean; value?: Record<string, unknown>; error?: { message: string } } };
    assert.equal(body.result.ok, true, `${method}: ${JSON.stringify(body.result.error)}`);
    return body.result.value as Record<string, unknown>;
  };

  const wsUrl = `${httpBase.replace(/^http/, "ws")}/api-gw/v1/proxy/events.mux`;
  const ws = new WebSocket(wsUrl, { headers: { "x-api-key": KEY } });
  const envelopes: Array<{ type: string; rpcId: string; method: string; payload: Record<string, unknown> }> = [];
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  ws.on("message", (data) => {
    envelopes.push(JSON.parse(String(data)));
  });

  const workspace = mkdtempSync(path.join(tmpdir(), "pi-facade-ask-run-"));
  const created = await rpc("session.create", { cwd: workspace });
  const sessionId = created["sessionId"] as string;

  const prompted = await rpc("session.prompt", {
    sessionId,
    mode: "queue",
    content: [{ type: "text", text: "Ask the operator which option to pick, then report the choice." }],
  });
  assert.deepEqual(prompted, { accepted: true });

  // Wait for the question card on the mux.
  const deadline = Date.now() + 60_000;
  let asked: { rpcId: string; payload: Record<string, unknown> } | undefined;
  for (;;) {
    const env = envelopes.find((e) => e.method === "question/requested" && e.payload["sessionId"] === sessionId);
    if (env !== undefined) {
      asked = { rpcId: env.rpcId, payload: env.payload };
      break;
    }
    assert.ok(Date.now() < deadline, `no question/requested frame; got ${envelopes.map((e) => e.method).join(",")}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(asked);
  assert.ok(asked.rpcId.length > 0, "the question envelope carries the respond rpcId");
  const questions = asked.payload["questions"] as Array<Record<string, unknown>>;
  assert.equal(questions[0]?.["id"], "q1");
  assert.equal(questions[0]?.["question"], "Which option do you pick?");

  // The tool call frame preceded the card.
  const events = envelopes.filter((e) => e.method === "session/event").map((e) => e.payload["event"] as Record<string, unknown>);
  assert.ok(events.some((e) => e["type"] === "tool/call" && (e["data"] as Record<string, unknown>)["name"] === "ask_user"));

  // Answer like the manager does.
  const respondRes = await fetch(`${httpBase}/api-gw/v1/proxy/respond`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": KEY },
    body: JSON.stringify({
      type: "client-response",
      rpcId: asked.rpcId,
      result: { ok: true, value: { sessionId, answer: { answers: [{ id: "q1", selected: ["B"] }] } } },
    }),
  });
  assert.deepEqual(await respondRes.json(), { accepted: true });

  // The run completes with the answer inside the tool result.
  for (;;) {
    const end = envelopes.find(
      (e) => e.method === "session/event" && (e.payload["event"] as Record<string, unknown>)?.["type"] === "turn/end",
    );
    if (end !== undefined) break;
    assert.ok(Date.now() < deadline, "run never completed after the answer");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const blob = JSON.stringify(envelopes);
  assert.ok(blob.includes("question/resolved"), "the resolved frame closes the card on the wire");
  const toolResult = envelopes
    .filter((e) => e.method === "session/event")
    .map((e) => e.payload["event"] as Record<string, unknown>)
    .find((e) => e["type"] === "tool/result");
  assert.ok(toolResult, "a tool/result frame exists for ask_user");
  assert.ok(JSON.stringify(toolResult).includes("B"), "the operator's answer reaches the model as the tool result");
  assert.ok(blob.includes("The operator picked B"), "the final assistant message reflects the answer");
  ws.close();
});
