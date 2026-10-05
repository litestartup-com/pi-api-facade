/**
 * OpenAI-compatible endpoint adaptation (env-driven, out of the box).
 *
 * Evidence base (pinned Pi 0.87.1 docs): models.md §"Configure a compatible
 * endpoint" — providers.<id> = {baseUrl, api:"openai-completions", apiKey,
 * models:[{id}]}; apiKey supports "$NAME" env interpolation (the secret never
 * touches disk); registering only baseUrl for an existing provider preserves
 * its built-in models; a models entry adds or replaces the same id.
 * providers.md — the built-in openai provider reads OPENAI_API_KEY natively,
 * so omitting apiKey from the synthesized entry keeps that fallback alive.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.ts";
import { applyOpenAiCompat } from "../src/openai-compat.ts";
import { SdkPiEngine } from "../src/engine-sdk.ts";
import type { MuxPayload } from "../src/engine.ts";

const readModels = (dir: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(dir, "models.json"), "utf8")) as Record<string, unknown>;

// ---- config surface ----

test("config: PI_OPENAI_BASE_URL enables the compat block with sane defaults", () => {
  const cfg = loadConfig({ PI_FACADE_API_KEYS: "k", PI_OPENAI_BASE_URL: "https://compat.example/v1" });
  assert.ok(cfg.openaiCompat);
  assert.equal(cfg.openaiCompat.baseUrl, "https://compat.example/v1");
  assert.equal(cfg.openaiCompat.provider, "openai");
  assert.deepEqual(cfg.openaiCompat.models, []);
  assert.equal(cfg.openaiCompat.apiKeyRef, null, "no key env set -> field omitted, Pi env fallback stays alive");
});

test("config: compat block is null without PI_OPENAI_BASE_URL", () => {
  const cfg = loadConfig({ PI_FACADE_API_KEYS: "k" });
  assert.equal(cfg.openaiCompat, null);
});

test("config: key, provider id and model list parse; bad values rejected", () => {
  const cfg = loadConfig({
    PI_FACADE_API_KEYS: "k",
    PI_OPENAI_BASE_URL: "http://127.0.0.1:9/v1",
    PI_OPENAI_API_KEY: "sk-secret",
    PI_OPENAI_PROVIDER: "my-proxy",
    PI_OPENAI_MODELS: " gpt-x , qwen-7b ,, ",
  });
  assert.ok(cfg.openaiCompat);
  assert.equal(cfg.openaiCompat.apiKeyRef, "$PI_OPENAI_API_KEY", "the key is referenced by env interpolation, never inlined");
  assert.equal(cfg.openaiCompat.provider, "my-proxy");
  assert.deepEqual(cfg.openaiCompat.models, ["gpt-x", "qwen-7b"]);

  assert.throws(() => loadConfig({ PI_FACADE_API_KEYS: "k", PI_OPENAI_BASE_URL: "ftp://x" }), /PI_OPENAI_BASE_URL/);
  assert.throws(() => loadConfig({ PI_FACADE_API_KEYS: "k", PI_OPENAI_BASE_URL: "http://x/v1", PI_OPENAI_PROVIDER: "a/b" }), /PI_OPENAI_PROVIDER/);
});

// ---- models.json synthesis ----

test("synthesis: a fresh agentDir gets a models.json with the compat provider", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-compat-"));
  const cfg = loadConfig({
    PI_FACADE_API_KEYS: "k",
    PI_OPENAI_BASE_URL: "https://compat.example/v1",
    PI_OPENAI_API_KEY: "sk-secret",
    PI_OPENAI_MODELS: "model-a",
  });
  const res = applyOpenAiCompat(dir, cfg.openaiCompat!);
  assert.equal(res.changed, true);
  const providers = readModels(dir)["providers"] as Record<string, Record<string, unknown>>;
  const entry = providers["openai"];
  assert.equal(entry["baseUrl"], "https://compat.example/v1");
  assert.equal(entry["api"], "openai-completions");
  assert.equal(entry["apiKey"], "$PI_OPENAI_API_KEY");
  assert.deepEqual(entry["models"], [{ id: "model-a" }]);
  assert.ok(!readFileSync(path.join(dir, "models.json"), "utf8").includes("sk-secret"), "the literal key never touches disk");
});

test("synthesis: merges into an existing models.json; a user-defined same id wins", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-compat-"));
  writeFileSync(
    path.join(dir, "models.json"),
    JSON.stringify({ providers: { stub: { baseUrl: "http://s", api: "openai-completions", models: [{ id: "s1" }] } } }),
  );
  const cfg = loadConfig({ PI_FACADE_API_KEYS: "k", PI_OPENAI_BASE_URL: "https://compat.example/v1" });
  const res = applyOpenAiCompat(dir, cfg.openaiCompat!);
  assert.equal(res.changed, true);
  const providers = readModels(dir)["providers"] as Record<string, unknown>;
  assert.ok(providers["stub"], "foreign providers survive the merge");
  assert.ok(providers["openai"], "the compat provider is added");

  // A user-defined entry under the same id is never clobbered.
  const dir2 = mkdtempSync(path.join(tmpdir(), "pi-compat-"));
  writeFileSync(
    path.join(dir2, "models.json"),
    JSON.stringify({ providers: { openai: { baseUrl: "https://mine.example/v1", api: "openai-completions", models: [{ id: "mine" }] } } }),
  );
  const res2 = applyOpenAiCompat(dir2, cfg.openaiCompat!);
  assert.equal(res2.changed, false);
  const mine = (readModels(dir2)["providers"] as Record<string, Record<string, unknown>>)["openai"];
  assert.equal(mine["baseUrl"], "https://mine.example/v1");
});

test("synthesis: a corrupt models.json refuses to proceed with a clear error", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-compat-"));
  writeFileSync(path.join(dir, "models.json"), "{not json");
  const cfg = loadConfig({ PI_FACADE_API_KEYS: "k", PI_OPENAI_BASE_URL: "https://compat.example/v1" });
  assert.throws(() => applyOpenAiCompat(dir, cfg.openaiCompat!), /models\.json/);
});

// ---- end-to-end against a stub OpenAI-compatible endpoint ----

test("integration: an env-synthesized openai-compat provider completes a turn", async (t) => {
  process.env["PI_OFFLINE"] = "1";
  process.env["PI_OPENAI_API_KEY"] = "stub-key";
  t.after(() => {
    delete process.env["PI_OFFLINE"];
    delete process.env["PI_OPENAI_API_KEY"];
  });

  // Minimal OpenAI chat-completions SSE stub.
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
      const base = { id: "chatcmpl-stub", object: "chat.completion.chunk", created: 1790000000, model: "compat-model" };
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "COMPAT-OK" }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: 21, completion_tokens: 3, total_tokens: 24 } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const stubBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

  const agentDir = mkdtempSync(path.join(tmpdir(), "pi-compat-agent-"));
  const workspace = mkdtempSync(path.join(tmpdir(), "pi-compat-ws-"));
  const cfg = loadConfig({
    PI_FACADE_API_KEYS: "k",
    PI_OPENAI_BASE_URL: stubBase,
    PI_OPENAI_API_KEY: "stub-key",
    PI_OPENAI_MODELS: "compat-model",
  });
  applyOpenAiCompat(agentDir, cfg.openaiCompat!);

  const engine = new SdkPiEngine({
    agentDir,
    allowFullAccess: false,
    defaultModel: { provider: "openai", model: "compat-model" },
    allowModelNetwork: false,
  });
  const payloads: MuxPayload[] = [];
  engine.subscribeAll((payload) => payloads.push(payload));

  const created = await engine.createSession(workspace);
  await engine.prompt(created.sessionId, "say the word");

  const deadline = Date.now() + 60_000;
  for (;;) {
    const ended = payloads.some(
      (p) => p.type === "session/event" && (p.event as { type?: string }).type === "turn/end",
    );
    if (ended) break;
    assert.ok(Date.now() < deadline, `turn never ended; payloads: ${JSON.stringify(payloads.map((p) => p.type)).slice(0, 300)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const blob = JSON.stringify(payloads);
  assert.ok(blob.includes("COMPAT-OK"), "the stub endpoint's reply rides the wire");
  const assistant = payloads
    .filter((p): p is Extract<MuxPayload, { type: "session/event" }> => p.type === "session/event")
    .map((p) => p.event as { type: string; data?: Record<string, unknown> })
    .find((e) => e.type === "assistant/message");
  const usage = assistant?.data?.["usage"] as Record<string, unknown> | undefined;
  assert.ok(usage && typeof usage["inputTokens"] === "number", "usage arrives with the DSH field names");
  await engine.release(created.sessionId);
});
