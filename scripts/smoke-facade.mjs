/**
 * Wire-level smoke against a RUNNING pi-api-facade with a real provider.
 * Not part of `npm run check` (it spends real tokens); run it manually:
 *
 *   FACADE_URL=http://127.0.0.1:3091 FACADE_KEY=<key> SMOKE_CWD=<workspace> node scripts/smoke-facade.mjs
 *
 * Walks the manager's own call pattern (contract-map §1): health → describe →
 * models → create → sandbox pin → mux subscribe → prompt (a real tool round) →
 * frames until turn/end → history → list → pending. Exits 0 on PASS.
 */
import { existsSync } from "node:fs";
import { WebSocket } from "ws";

const url = process.env.FACADE_URL ?? "http://127.0.0.1:3091";
const key = process.env.FACADE_KEY ?? "";
const cwd = process.env.SMOKE_CWD ?? "";
if (key === "" || cwd === "") {
  console.error("FACADE_KEY and SMOKE_CWD are required");
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
    body: JSON.stringify({ type: "client-request", rpcId: `smoke-${method}`, method, payload }),
  });
  if (res.status !== 200) throw new Error(`${method}: HTTP ${res.status}`);
  const body = await res.json();
  if (body?.type !== "server-response") throw new Error(`${method}: not a server-response`);
  if (body.result?.ok !== true) throw new Error(`${method}: ${JSON.stringify(body.result?.error)}`);
  return body.result.value;
};

// 1. health (unauthenticated)
{
  const res = await fetch(`${url}${prefix}/health`);
  const body = await res.json();
  step("health", res.status === 200 && body.ok === true, `service=${body.service} version=${body.version}`);
}

// 2. host.describe
const describe = await rpc("host.describe");
step("host.describe", typeof describe.version === "string" && describe.version.startsWith("pi-"), `version=${describe.version} allowFullAccess=${describe.allowFullAccess}`);

// 3. session.models — the deepseek group must be routable with real credentials
const catalog = await rpc("session.models");
const deepseek = catalog.groups?.find((g) => g.id === "deepseek");
step("session.models", catalog.routable === true && deepseek !== undefined && deepseek.models.length > 0, `groups=${catalog.groups?.map((g) => g.id).join(",")} current=${JSON.stringify(catalog.current)}`);

// 4. session.create
const created = await rpc("session.create", { cwd });
step("session.create", typeof created.sessionId === "string", `sessionId=${created.sessionId} model=${created.provider}/${created.model}`);
const sessionId = created.sessionId;

// 5. sandbox pin (workspace-write)
{
  const res = await fetch(`${url}${prefix}/sessions/${sessionId}/sandbox-mode`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ mode: "workspace-write" }),
  });
  step("sandbox-mode pin", res.status === 200, `HTTP ${res.status}`);
}

// 6. mux subscribe before prompting (the manager's order)
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
  if (env?.payload?.sessionId === sessionId) frames.push(env);
});

// 7. prompt — a real tool round (write smoke.txt), the audit hook should commit it
const prompted = await rpc("session.prompt", {
  sessionId,
  mode: "queue",
  content: [{ type: "text", text: "Use the write tool to create a file named smoke.txt in the current directory containing exactly SMOKE-OK. Do nothing else." }],
});
step("session.prompt accepted", prompted.accepted === true);

// 8. wait for turn/end
const turnEnd = await new Promise((resolve) => {
  const deadline = Date.now() + 180_000;
  const timer = setInterval(() => {
    const end = frames.find((e) => e.payload?.event?.type === "turn/end");
    if (end !== undefined) {
      clearInterval(timer);
      resolve(end);
    } else if (Date.now() > deadline) {
      clearInterval(timer);
      resolve(null);
    }
  }, 100);
});
const eventTypes = frames.filter((e) => e.method === "session/event").map((e) => e.payload.event.type);
step("turn/end arrived", turnEnd !== null, `frames=${frames.length} types=${[...new Set(eventTypes)].join(",")}`);
if (turnEnd !== null) {
  step("turn/end reason completed", turnEnd.payload.event.data?.reason?.kind === "completed", JSON.stringify(turnEnd.payload.event.data?.reason));
}
step("stream chunks seen", eventTypes.includes("assistant/chunk"));
step("tool round seen", eventTypes.includes("tool/call") && eventTypes.includes("tool/result"));
const assistantMsg = frames.find((e) => e.payload?.event?.type === "assistant/message" && e.payload.event.data?.usage);
const usage = assistantMsg?.payload?.event?.data?.usage;
step("usage on the wire (DSH field names)", usage !== undefined && usage.inputTokens > 0 && usage.outputTokens > 0 && !("cost" in (usage ?? {})), JSON.stringify(usage));
step("smoke.txt written by the model", existsSync(`${cwd}/smoke.txt`));

// 9. history
const history = await rpc("session.history", { sessionId });
const histTypes = history.events.map((e) => e.event.type);
step(
  "session.history replays the run",
  history.events.length > 0 && histTypes.includes("user/message") && histTypes.includes("assistant/message") && histTypes.includes("tool/call"),
  `events=${history.events.length} permissions=${JSON.stringify(history.projections?.values?.permissions)}`,
);

// 10. session.list
const list = await rpc("session.list");
step("session.list contains the session", Array.isArray(list.items) && list.items.some((i) => i.sessionId === sessionId), `items=${list.items?.length}`);

// 11. card recovery surface (nothing pending in this smoke)
{
  const res = await fetch(`${url}${prefix}/answerer/pending`, { headers: { "x-api-key": key } });
  const body = await res.json();
  step("answerer/pending", res.status === 200 && Array.isArray(body.pending) && body.pending.length === 0, `pending=${body.pending?.length}`);
}

ws.close();
console.log(failures === 0 ? "\nSMOKE PASS" : `\nSMOKE FAIL (${failures} failure(s))`);
process.exit(failures === 0 ? 0 : 1);
