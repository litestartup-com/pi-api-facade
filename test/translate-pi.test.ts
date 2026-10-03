/**
 * F3 unit gate: the Pi → wire translation, asserted field by field against
 * recorded live events (test/fixtures/pi-events.json, real deepseek-flash run).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  contentBlocksToWire,
  historyEntriesToEvents,
  renameUsage,
  stopReasonToTurnReason,
  SessionTranslator,
} from "../src/translate-pi.ts";

const fixtures = JSON.parse(
  readFileSync(new URL("./fixtures/pi-events.json", import.meta.url), "utf8"),
) as { round: unknown[]; abortedRound: unknown[]; toolRound: unknown[] };

const run = (events: readonly unknown[]): Array<{ type: string; seq: number; data: Record<string, unknown> }> => {
  const translator = new SessionTranslator();
  const out: Array<{ type: string; seq: number; data: Record<string, unknown> }> = [];
  for (const event of events) out.push(...translator.onEvent(event));
  return out;
};

test("recorded round: exact wire frame sequence (gate: field by field)", () => {
  const frames = run(fixtures.round);
  assert.deepEqual(
    frames.map((f) => f.type),
    ["turn/start", "user/message", "assistant/chunk", "assistant/chunk", "assistant/message", "turn/end"],
  );
  assert.deepEqual(frames[0]!.data, { turn: 1 });
  const user = frames[1]!.data;
  assert.deepEqual(user["content"], [{ type: "text", text: "Reply with exactly one word: PONG" }]);
  assert.deepEqual(frames[2]!.data, { chunk: { type: "text-delta", text: "P" } });
  assert.deepEqual(frames[3]!.data, { chunk: { type: "text-delta", text: "ONG" } });
  assert.deepEqual(frames[4]!.data, {
    message: { content: [{ type: "text", text: "PONG" }] },
    usage: { inputTokens: 453, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
  });
  assert.deepEqual(frames[5]!.data, { turn: 1, reason: { kind: "completed" } });
  // seq is strictly increasing per session
  assert.deepEqual(frames.map((f) => f.seq), [1, 2, 3, 4, 5, 6]);
});

test("system and user message frames never carry usage; system never reaches the wire", () => {
  const frames = run(fixtures.round);
  for (const frame of frames) {
    if (frame.type === "user/message") assert.ok(!("usage" in frame.data));
  }
  assert.ok(!frames.some((f) => JSON.stringify(f.data).includes("preamble")));
});

test("aborted run: turn/end reports aborted with the abort detail", () => {
  const frames = run(fixtures.abortedRound);
  const end = frames.find((f) => f.type === "turn/end");
  assert.ok(end);
  assert.deepEqual(end.data, { turn: 1, reason: { kind: "aborted", reason: { kind: "abort" } } });
});

test("tool round: tool_execution events map to tool/call + tool/result, entry-form deduped", () => {
  const frames = run(fixtures.toolRound);
  const call = frames.find((f) => f.type === "tool/call");
  assert.ok(call);
  assert.deepEqual(call.data, { name: "bash", arguments: JSON.stringify({ command: "ls" }) });
  const results = frames.filter((f) => f.type === "tool/result");
  assert.equal(results.length, 1, "tool_execution_end and the toolResult message must not double-emit");
  const data = results[0]!.data as { message: { content: Array<{ content: unknown; isError: boolean }> } };
  assert.deepEqual(data.message.content[0]!.content, [{ type: "text", text: "file-a\nfile-b" }]);
  assert.equal(data.message.content[0]!.isError, false);
});

test("renameUsage: Pi field names in, DSH field names out, cost dropped", () => {
  const usage = renameUsage({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 5, totalTokens: 15, cost: { total: 9 } });
  assert.deepEqual(usage, { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, reasoningTokens: 5 });
  assert.equal(renameUsage({ cost: { total: 1 } }), null, "no token counts → null (never partial garbage)");
  assert.equal(renameUsage(null), null);
});

test("stopReason mapping covers the full Pi union", () => {
  assert.deepEqual(stopReasonToTurnReason("stop"), { kind: "completed" });
  assert.deepEqual(stopReasonToTurnReason("toolUse"), { kind: "completed" });
  assert.deepEqual(stopReasonToTurnReason("length"), { kind: "max_tokens" });
  assert.deepEqual(stopReasonToTurnReason("aborted"), { kind: "aborted", reason: { kind: "abort" } });
  assert.deepEqual(stopReasonToTurnReason("error", "boom"), { kind: "error", error: { message: "boom", code: "provider_error" } });
});

test("contentBlocksToWire: thinking blocks become reasoning, toolCall blocks drop", () => {
  const blocks = contentBlocksToWire([
    { type: "thinking", thinking: "hmm" },
    { type: "text", text: "answer" },
    { type: "toolCall", id: "c1", name: "bash", arguments: {} },
  ]);
  assert.deepEqual(blocks, [
    { type: "reasoning", text: "hmm" },
    { type: "text", text: "answer" },
  ]);
});

test("failTurn closes an open turn with an error reason; opens one when none was open", () => {
  const translator = new SessionTranslator();
  const cold = translator.failTurn("boom");
  assert.deepEqual(cold.map((f) => f.type), ["turn/start", "turn/end"]);
  assert.deepEqual(cold[1]!.data, { turn: 1, reason: { kind: "error", error: { message: "boom", code: "prompt_failed" } } });
  // after failing, a new run opens turn 2
  const reopened = translator.onEvent({ type: "turn_start" });
  assert.deepEqual(reopened.map((f) => f.type), ["turn/start"]);
  assert.deepEqual(reopened[0]!.data, { turn: 2 });
});

test("historyEntriesToEvents: synthesized turn boundaries around assistant messages", () => {
  const entries = [
    { type: "message", id: "e1", message: { role: "system", content: "" } },
    { type: "message", id: "e2", message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 } },
    { type: "model_change", id: "e3", provider: "deepseek", modelId: "deepseek-flash" },
    {
      type: "message",
      id: "e4",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { total: 0 } },
        stopReason: "stop",
      },
    },
    { type: "session_info", id: "e5", name: "greeting" },
  ];
  const events = historyEntriesToEvents(entries);
  assert.deepEqual(events.map((e) => e.type), ["user/message", "turn/start", "assistant/message", "turn/end"]);
  const assistant = events[2]!;
  assert.deepEqual(assistant.data["usage"], { inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 });
});

test("history regression (smoke 2026-10-02): tool calls persist as assistant content blocks — history must synthesize tool/call, one turn per run", () => {
  const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0 } };
  const entries = [
    { type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "make a file" }], timestamp: 1 } },
    {
      type: "message",
      id: "a1",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "write", arguments: { path: "smoke.txt", content: "SMOKE-OK" } }],
        usage,
        stopReason: "toolUse",
      },
    },
    { type: "message", id: "t1", message: { role: "toolResult", toolCallId: "call-1", toolName: "write", content: [{ type: "text", text: "ok" }], isError: false } },
    { type: "message", id: "a2", message: { role: "assistant", content: [{ type: "text", text: "done" }], usage, stopReason: "stop" } },
    { type: "message", id: "u2", message: { role: "user", content: [{ type: "text", text: "next run" }], timestamp: 2 } },
    { type: "message", id: "a3", message: { role: "assistant", content: [{ type: "text", text: "ok2" }], usage, stopReason: "stop" } },
  ];
  const events = historyEntriesToEvents(entries);
  assert.deepEqual(
    events.map((e) => e.type),
    [
      "user/message", // run 1
      "turn/start",
      "assistant/message",
      "tool/call",
      "tool/result",
      "assistant/message",
      "turn/end", // closed when run 2's user message arrives
      "user/message", // run 2
      "turn/start",
      "assistant/message",
      "turn/end",
    ],
  );
  assert.deepEqual(events[3]!.data, { name: "write", arguments: JSON.stringify({ path: "smoke.txt", content: "SMOKE-OK" }) });
  assert.deepEqual(events[6]!.data["reason"], { kind: "completed" }, "the run's reason comes from its LAST assistant stopReason");
  assert.deepEqual(events[1]!.data, { turn: 1 });
  assert.deepEqual(events[8]!.data, { turn: 2 }, "turn numbers increase across runs");
});
