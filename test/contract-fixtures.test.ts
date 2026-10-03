/**
 * F1 gate: the golden wire samples must satisfy the invariants the manager's
 * consumer code enforces (docs/contract-map.md cites the exact sources).
 * These assertions are deliberately written from the manager's perspective —
 * they are the acceptance shape every later phase codes against.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const samples = JSON.parse(
  readFileSync(new URL("./fixtures/wire-samples.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

const rec = (value: unknown): Record<string, unknown> => {
  assert.ok(value !== null && typeof value === "object", "expected an object");
  return value as Record<string, unknown>;
};

test("rpc envelope: client-request carries type/rpcId/method/payload", () => {
  const env = rec(samples["clientRequest"]);
  assert.equal(env["type"], "client-request");
  assert.equal(typeof env["rpcId"], "string");
  assert.equal(typeof env["method"], "string");
  assert.ok("payload" in env);
});

test("rpc envelope: server-response discriminates on result.ok and error has code+message", () => {
  const ok = rec(rec(samples["serverResponseOk"])["result"]);
  assert.equal(ok["ok"], true);
  assert.ok("value" in ok);
  const err = rec(rec(samples["serverResponseError"])["result"]);
  assert.equal(err["ok"], false);
  const error = rec(err["error"]);
  assert.equal(typeof error["code"], "string");
  assert.equal(typeof error["message"], "string");
});

test("prompt params: mode queue + text content block (also the cold-resume shape)", () => {
  const payload = rec(rec(samples["promptRequest"])["payload"]);
  assert.equal(payload["mode"], "queue");
  const content = payload["content"] as Array<Record<string, unknown>>;
  assert.equal(content[0]?.["type"], "text");
  assert.equal(typeof content[0]?.["text"], "string");
});

test("usage wire fields are the DSH names, never Pi's, and cost stays off the wire", () => {
  const event = rec(
    rec(rec(samples["muxSessionEventAssistantMessage"])["payload"])["event"],
  );
  const usage = rec(rec(event["data"])["usage"]);
  for (const key of ["inputTokens", "outputTokens"]) {
    assert.equal(typeof usage[key], "number", `missing ${key}`);
  }
  for (const forbidden of ["input", "output", "cost", "totalTokens"]) {
    assert.ok(!(forbidden in usage), `Pi-side field ${forbidden} must not leak onto the wire`);
  }
});

test("mux card frames: envelope method equals payload type and carries the respond rpcId", () => {
  const env = rec(samples["muxApprovalRequested"]);
  const payload = rec(env["payload"]);
  assert.equal(env["method"], payload["type"]);
  assert.equal(env["method"], "approval/requested");
  assert.equal(typeof env["rpcId"], "string");
  assert.ok((env["rpcId"] as string).length > 0, "card frames must carry a non-empty rpcId");
  assert.equal(typeof payload["approvalId"], "string");
  assert.equal(typeof payload["toolName"], "string");
});

test("answerer/pending entries echo the original frame payload verbatim", () => {
  const body = rec(samples["answererPending"]);
  const pending = body["pending"] as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(pending) && pending.length > 0);
  const entry = rec(pending[0]);
  assert.equal(entry["method"], "approval/requested");
  const payload = rec(entry["payload"]);
  assert.equal(payload["type"], entry["method"]);
  assert.equal(typeof payload["sessionId"], "string");
});

test("history value: events wrap bare events, projections feed the composer bar", () => {
  const value = rec(samples["sessionHistoryValue"]);
  assert.equal(value["hasMore"], false);
  const events = value["events"] as Array<Record<string, unknown>>;
  assert.ok(events.every((e) => "event" in e), "every item wraps {event}");
  const types = events.map((e) => rec(e["event"])["type"]);
  assert.deepEqual(types, ["user/message", "turn/start", "assistant/message", "turn/end"]);
  const values = rec(rec(value["projections"])["values"]);
  const pressure = rec(values["contextPressure"]);
  assert.equal(typeof pressure["projectedTokens"], "number");
  assert.equal(typeof pressure["contextWindow"], "number");
  assert.equal(rec(values["permissions"])["currentValue"], "workspace-write");
});

test("turn/end reason kinds stay inside the manager-handled vocabulary", () => {
  const event = rec(rec(samples["muxSessionEventTurnEnd"])["payload"])["event"];
  const data = rec(rec(event)["data"]);
  assert.equal(rec(data["reason"])["kind"], "completed");
});

test("session.list items put the title under projections.values", () => {
  const value = rec(samples["sessionListValue"]);
  const items = value["items"] as Array<Record<string, unknown>>;
  const first = rec(items[0]);
  assert.equal(typeof first["sessionId"], "string");
  assert.equal(rec(rec(first["projections"])["values"])["title"], "PONG round");
});

test("host.describe exposes exactly what the manager reads plus parity fields", () => {
  const value = rec(samples["hostDescribeValue"]);
  assert.equal(typeof value["version"], "string");
  assert.equal(typeof value["allowFullAccess"], "boolean");
  assert.equal(value["protocol"], "0.0.1");
});
