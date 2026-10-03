/**
 * F4 gate (engine level): the approval bridge end to end, offline. The stub
 * provider scripts a tool-calling round; the danger-tier session must route the
 * tool call through the injected gate (inline extension tool_call hook), block
 * on "rejected", and still complete the run; a workspace-write session must
 * never touch the gate.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { SdkPiEngine } from "../src/engine-sdk.ts";
import type { ApprovalRequest, MuxPayload } from "../src/engine.ts";

type ScriptedResponse =
  | { kind: "toolcall"; id: string; name: string; args: string }
  | { kind: "text"; text: string };

const script: ScriptedResponse[] = [
  { kind: "toolcall", id: "call-1", name: "bash", args: JSON.stringify({ command: "echo hello" }) },
  { kind: "text", text: "DONE-AFTER-BLOCK" },
  { kind: "toolcall", id: "call-2", name: "bash", args: JSON.stringify({ command: "echo hello" }) },
  { kind: "text", text: "NON-DANGER-DONE" },
];
let scriptIndex = 0;

interface StubState {
  port: number;
  close: () => Promise<void>;
}

const startStub = async (): Promise<StubState> => {
  const server = http.createServer((req, res) => {
    req.on("data", () => {
      // drain the request body; the stub ignores it
    });
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
        chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
        chunk({ ...base, choices: [{ index: 0, delta: { content: entry.text }, finish_reason: null }] });
        chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      }
      chunk({ ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
};

let stub: StubState;
let engine: SdkPiEngine;
let workspace: string;
const gateCalls: ApprovalRequest[] = [];

const runToSettled = async (sessionId: string, text: string, timeoutMs = 90_000): Promise<MuxPayload[]> => {
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
  await engine.prompt(sessionId, text);
  await finished;
  clearTimeout(timer);
  unsubscribe();
  return frames;
};

const eventTypes = (frames: MuxPayload[]): string[] =>
  frames.flatMap((f) => (f.type === "session/event" ? [f.event.type] : [f.type]));

before(async () => {
  process.env["PI_OFFLINE"] = "1";
  stub = await startStub();
  const agentDir = mkdtempSync(path.join(tmpdir(), "pi-facade-appr-"));
  workspace = mkdtempSync(path.join(tmpdir(), "pi-facade-appr-ws-"));
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
    allowFullAccess: true,
    defaultModel: { provider: "stub", model: "stub-model" },
    allowModelNetwork: false,
    approvalGate: async (request) => {
      gateCalls.push(request);
      return "rejected";
    },
  });
});

after(async () => {
  await stub.close();
});

test("danger tier: tool call routes through the gate, rejection blocks and the run still completes", async () => {
  const created = await engine.createSession(workspace);
  await engine.setSandboxMode(created.sessionId, "danger-full-access");

  const frames = await runToSettled(created.sessionId, "please run echo hello");
  const types = eventTypes(frames);

  assert.equal(gateCalls.length, 1, "the gate fired exactly once");
  assert.equal(gateCalls[0]!.toolName, "bash");
  assert.equal(gateCalls[0]!.sessionId, created.sessionId);
  assert.equal(gateCalls[0]!.approvalId, "call-1");
  assert.ok(gateCalls[0]!.reason?.includes("echo hello"), "the card reason carries the tool input");

  assert.ok(types.includes("tool/call"), `expected a tool/call frame, got ${types.join(",")}`);
  assert.ok(types.includes("tool/result"), "the blocked call still produces a result frame");
  const blob = JSON.stringify(frames);
  assert.ok(blob.includes("the operator rejected"), "the block reason reaches the transcript");
  assert.ok(blob.includes("DONE-AFTER-BLOCK"), "the run continues to the final assistant message");
  assert.equal(types[types.length - 1], "turn/end");
  const end = frames[frames.length - 1];
  assert.ok(end.type === "session/event");
  assert.deepEqual(end.event.data["reason"], { kind: "completed" });
});

test("workspace-write tier: the gate is never consulted", async () => {
  const before = gateCalls.length;
  const created = await engine.createSession(workspace);
  // no setSandboxMode → default tier workspace-write
  const frames = await runToSettled(created.sessionId, "please run echo hello");
  assert.equal(gateCalls.length, before, "no approval card outside the danger tier");
  const blob = JSON.stringify(frames);
  assert.ok(blob.includes("NON-DANGER-DONE"));
  assert.equal(eventTypes(frames).at(-1), "turn/end");
});
