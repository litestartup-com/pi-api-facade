/**
 * F0 gate: the scaffold boots, serves {prefix}/health without auth,
 * and 404s unknown paths. Port 0 = ephemeral, so tests never clash
 * with a real facade on the default port.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";
import { buildServer, serviceVersion } from "../src/server.ts";
import { FakePiEngine } from "../src/engine-fake.ts";

const config = loadConfig({ PI_FACADE_PORT: "0", PI_FACADE_HOST: "127.0.0.1" });
const app = await buildServer(config, new FakePiEngine());
const base = await app.listen({ port: 0, host: "127.0.0.1" });

after(async () => {
  await app.close();
});

test("config defaults: loopback, prefix /api-gw/v1, full access locked, no keys", () => {
  const c = loadConfig({});
  assert.equal(c.host, "127.0.0.1");
  assert.equal(c.prefix, "/api-gw/v1");
  assert.equal(c.allowFullAccess, false);
  assert.equal(c.port, 3091);
  assert.deepEqual(c.apiKeys, []);
});

test("config rejects a malformed port instead of binding garbage", () => {
  assert.throws(() => loadConfig({ PI_FACADE_PORT: "not-a-port" }), /PI_FACADE_PORT/);
  assert.throws(() => loadConfig({ PI_FACADE_PORT: "-1" }), /PI_FACADE_PORT/);
});

test("config parses PI_FACADE_API_KEYS as a trimmed comma list", () => {
  const c = loadConfig({ PI_FACADE_API_KEYS: " a1 , ,b2 " });
  assert.deepEqual(c.apiKeys, ["a1", "b2"]);
});

test("GET {prefix}/health responds 200 without auth", async () => {
  const res = await fetch(`${base}${config.prefix}/health`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body["ok"], true);
  assert.equal(body["service"], "pi-api-facade");
  assert.equal(body["version"], serviceVersion);
  // Demo-BFF parity (D0 finding G2): probes render `${status}/${upstream}`.
  assert.equal(body["status"], "ok");
  assert.equal(typeof body["upstream"], "string");
  assert.match(String(body["upstream"]), /^pi-/);
});

test("unknown paths 404 (no accidental route exposure)", async () => {
  const res = await fetch(`${base}/definitely-not-a-route`);
  assert.equal(res.status, 404);
});
