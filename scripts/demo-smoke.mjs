/**
 * Demo-stack wiring smoke — drives the two demo BFFs (KB Studio + Support
 * widget) exactly the way their browsers do: static pages, file CRUD, doc sync,
 * chat rounds over SSE, history. Works against the FAKE engine (no tokens), so
 * it is CI-safe; run it after `docker compose ... up` with the demos overlay,
 * or against locally-run BFFs:
 *
 *   DEMO_BASE=http://127.0.0.1:8090 node scripts/demo-smoke.mjs
 */
const base = (process.env.DEMO_BASE ?? "http://127.0.0.1:8090").replace(/\/+$/, "");

let failures = 0;
const step = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

const json = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, body: parsed, text };
};

/** Consumes the BFF's SSE stream until turn_end (or timeout); returns the events seen. */
const readStream = async (path, timeoutMs = 60_000) => {
  const res = await fetch(`${base}${path}`, { headers: { accept: "text/event-stream" } });
  if (!res.ok) throw new Error(`stream ${path}: HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const events = [];
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (Date.now() > deadline) break;
    const { done, value } = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ done: true, value: undefined }), Math.max(0, deadline - Date.now()))),
    ]);
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary === -1) break;
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7).trim();
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (data !== "") events.push({ event, data: JSON.parse(data) });
      else if (event !== "message") events.push({ event, data: null });
      if (event === "turn_end") {
        try { reader.cancel(); } catch { /* done */ }
        return events;
      }
    }
  }
  try { reader.cancel(); } catch { /* done */ }
  return events;
};

const chatRound = async (prefix, marker) => {
  const posted = await json("POST", `${prefix}/api/chat`, { text: `Reply with exactly: ${marker}` });
  if (posted.status !== 200 || typeof posted.body?.sid !== "string") {
    step(`${prefix} chat accept`, false, `HTTP ${posted.status} ${posted.text?.slice(0, 120)}`);
    return;
  }
  const sid = posted.body.sid;
  const events = await readStream(`${prefix}/api/stream?sid=${encodeURIComponent(sid)}`);
  const kinds = events.map((e) => e.event);
  const message = events.find((e) => e.event === "message");
  step(`${prefix} chat round`, kinds.includes("turn_start") && kinds.includes("turn_end") && message !== undefined, `events=${[...new Set(kinds)].join(",")}`);
  // The fake engine echoes "fake:<prompt>"; a real provider answers freely — accept either.
  if (message !== undefined) {
    const text = String(message.data?.text ?? "");
    step(`${prefix} assistant text`, text.length > 0, text.slice(0, 60));
  }
  const history = await json("GET", `${prefix}/api/history?sid=${encodeURIComponent(sid)}`);
  const messages = history.body?.messages ?? [];
  step(`${prefix} history transcript`, messages.length >= 2 && messages[0].role === "user", `messages=${messages.length}`);
};

// ---- static pages through the front door ----
for (const [name, path] of [["KB Studio page", "/kb/"], ["Support widget page", "/cs/"]]) {
  const res = await fetch(`${base}${path}`);
  const text = await res.text();
  step(name, res.status === 200 && text.includes("<html"), `HTTP ${res.status}`);
}

// ---- BFF health (facade reachability from inside the demo tier) ----
for (const prefix of ["/kb", "/cs"]) {
  const h = await json("GET", `${prefix}/api/health`);
  const facade = String(h.body?.facade ?? "");
  step(`${prefix} health`, h.status === 200 && h.body?.ok === true && facade.startsWith("ok/"), `facade=${facade}`);
}

// ---- KB file CRUD + doc sync (BFF-side channel, zero tokens) ----
{
  const tree = await json("GET", "/kb/api/tree");
  const paths = (tree.body?.files ?? []).map((f) => f.path);
  step("kb tree seeded", paths.includes("AGENTS.md") && paths.some((p) => p.startsWith("content/docs/")), `files=${paths.length}`);

  const created = await json("POST", "/kb/api/file", { path: "content/notes/demo-smoke.md", content: "# smoke\n" });
  step("kb file create", created.status === 201, `HTTP ${created.status}`);
  const read = await json("GET", "/kb/api/file?path=content/notes/demo-smoke.md");
  step("kb file read", read.status === 200 && read.body?.content === "# smoke\n");
  const updated = await json("PUT", "/kb/api/file", { path: "content/notes/demo-smoke.md", content: "# smoke v2\n" });
  step("kb file update", updated.status === 200);
  const deleted = await json("DELETE", "/kb/api/file?path=content/notes/demo-smoke.md");
  step("kb file delete", deleted.status === 200);
  const guard = await json("PUT", "/kb/api/file", { path: "AGENTS.md", content: "nope" });
  step("kb seed guard (AGENTS.md 403)", guard.status === 403, `HTTP ${guard.status}`);

  const sync = await json("POST", "/kb/api/sync");
  const synced = sync.body?.synced ?? [];
  step("kb doc sync (pi docs)", sync.status === 200 && synced.includes("README.md") && synced.includes("runbook.md"), `synced=${synced.join(",")}`);
}

// ---- chat rounds through both BFFs (fake engine: no tokens) ----
await chatRound("/kb", "KB-SMOKE-OK");
await chatRound("/cs", "CS-SMOKE-OK");

console.log(failures === 0 ? "\nDEMO SMOKE PASS" : `\nDEMO SMOKE FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
