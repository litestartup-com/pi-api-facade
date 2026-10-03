/**
 * Compose-stack wiring smoke — runs entirely against the FAKE engine, so it
 * needs no provider keys and spends no tokens. It is the CI gate for the
 * docker stack (nginx front door → facade → mux WebSocket), and the quick
 * local check after `docker compose up`:
 *
 *   FACADE_URL=http://127.0.0.1:8090 FACADE_KEY=<key> node scripts/compose-smoke.mjs
 *
 * Covers: health (through nginx), host.describe, session.create, sandbox pin,
 * mux frames over the nginx WebSocket upgrade, prompt → frames → turn_end,
 * history replay, session.list, answerer/pending, and the fail-closed 404.
 * For a real-provider round use scripts/smoke-facade.mjs instead.
 */
import { WebSocket } from "ws";

const url = process.env.FACADE_URL ?? "http://127.0.0.1:8090";
const key = process.env.FACADE_KEY ?? "";
if (key === "") {
  console.error("FACADE_KEY is required");
  process.exit(2);
}
const prefix = "/api-gw/v1";
const base = `${url}${prefix}/proxy`;
const auth = { "content-type": "application/json", "x-api-key": key };

let failures = 0;
const step = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const rpc = async (method, payload = {}) => {
  const res = await fetch(`${base}/${method}`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ type: "client-request", rpcId: `csmoke-${method}`, method, payload }),
  });
  if (res.status !== 200) throw new Error(`${method}: HTTP ${res.status}`);
  const body = await res.json();
  if (body?.result?.ok !== true) throw new Error(`${method}: ${JSON.stringify(body?.result?.error)}`);
  return body.result.value;
};

// 1. health through the nginx front door (and the demo-BFF parity fields)
{
  const res = await fetch(`${url}${prefix}/health`);
  const body = await res.json();
  step("health via nginx", res.status === 200 && body.ok === true && body.status === "ok" && typeof body.upstream === "string", JSON.stringify(body));
}

// 2. fail-closed front door: anything outside /api-gw/ is 404
{
  const res = await fetch(`${url}/definitely-not-a-route`);
  step("nginx fail-closed 404", res.status === 404, `HTTP ${res.status}`);
}

// 3. host.describe
const describe = await rpc("host.describe");
step("host.describe", typeof describe.version === "string", `version=${describe.version}`);

// 4. create + sandbox pin
const created = await rpc("session.create", { cwd: "/workspace/smoke" });
step("session.create", typeof created.sessionId === "string", `sessionId=${created.sessionId}`);
{
  const res = await fetch(`${url}${prefix}/sessions/${created.sessionId}/sandbox-mode`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ mode: "workspace-write" }),
  });
  step("sandbox-mode pin", res.status === 200, `HTTP ${res.status}`);
}

// 5. mux through the nginx WebSocket upgrade, then prompt → frames
const wsUrl = base.replace(/^http/, "ws") + "/events.mux";
const ws = new WebSocket(wsUrl, { headers: { "x-api-key": key } });
const frames = [];
await new Promise((resolve, reject) => {
  ws.once("open", resolve);
  ws.once("unexpected-response", (_q, res) => reject(new Error(`mux handshake ${res.statusCode}`)));
  ws.once("error", reject);
  setTimeout(() => reject(new Error("mux open timeout")), 10_000);
});
ws.on("message", (data) => {
  const env = JSON.parse(String(data));
  if (env?.payload?.sessionId === created.sessionId) frames.push(env);
});
step("mux open via nginx", true, wsUrl);

await rpc("session.prompt", { sessionId: created.sessionId, mode: "queue", content: [{ type: "text", text: "compose smoke" }] });
const turnEnd = await new Promise((resolve) => {
  const deadline = Date.now() + 30_000;
  const timer = setInterval(() => {
    const end = frames.find((e) => e.payload?.event?.type === "turn/end");
    if (end !== undefined) { clearInterval(timer); resolve(end); }
    else if (Date.now() > deadline) { clearInterval(timer); resolve(null); }
  }, 100);
});
const types = frames.filter((e) => e.method === "session/event").map((e) => e.payload.event.type);
step("prompt → frames → turn/end", turnEnd !== null && types.includes("assistant/message"), `types=${[...new Set(types)].join(",")}`);
step("envelope method = payload.type", frames.every((e) => e.method === e.payload?.type));
ws.close();

// 6. history / list / pending
const history = await rpc("session.history", { sessionId: created.sessionId });
step("session.history", Array.isArray(history.events) && history.events.length > 0, `events=${history.events?.length}`);
const list = await rpc("session.list");
step("session.list", Array.isArray(list.items) && list.items.some((i) => i.sessionId === created.sessionId), `items=${list.items?.length}`);
{
  const res = await fetch(`${url}${prefix}/answerer/pending`, { headers: { "x-api-key": key } });
  const body = await res.json();
  step("answerer/pending", res.status === 200 && Array.isArray(body.pending), `pending=${body.pending?.length}`);
}

console.log(failures === 0 ? "\nCOMPOSE SMOKE PASS" : `\nCOMPOSE SMOKE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
