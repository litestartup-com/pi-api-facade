/**
 * F5 gate: sandbox tier tool allowlists, facade-restart recovery (a fresh
 * engine on the same agentDir resumes persisted sessions), and the per-run git
 * commit hook. Offline: scripted text-only stub provider.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { SdkPiEngine } from "../src/engine-sdk.ts";
import { commitWorkspace } from "../src/git-hook.ts";
import type { MuxPayload } from "../src/engine.ts";

const run = promisify(execFile);

const replies = ["FIRST", "SECOND", "THIRD", "FOURTH"];
let replyIndex = 0;

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
      const text = replies[replyIndex++] ?? "EXTRA";
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
      const base = { id: "chatcmpl-stub", object: "chat.completion.chunk", created: 1790000000, model: "stub-model" };
      const chunk = (obj: unknown): void => {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
      };
      chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] });
      chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      chunk({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } });
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
let agentDir: string;
let workspace: string;

const makeEngine = (opts?: { withTools?: boolean; onRunSettled?: (info: { sessionId: string; cwd: string }) => void }): SdkPiEngine =>
  new SdkPiEngine({
    agentDir,
    allowFullAccess: true,
    defaultModel: { provider: "stub", model: "stub-model" },
    allowModelNetwork: false,
    ...(opts?.withTools === true ? {} : { noTools: "all" as const }),
    ...(opts?.onRunSettled !== undefined ? { onRunSettled: opts.onRunSettled } : {}),
  });

const runToSettled = async (engine: SdkPiEngine, sessionId: string, text: string, timeoutMs = 60_000): Promise<MuxPayload[]> => {
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

const gitLog = async (cwd: string): Promise<string[]> => {
  const { stdout } = await run("git", ["-C", cwd, "log", "--format=%s"]);
  return stdout.split("\n").filter((line) => line !== "");
};

const waitFor = async (condition: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};

before(async () => {
  process.env["PI_OFFLINE"] = "1";
  stub = await startStub();
  agentDir = mkdtempSync(path.join(tmpdir(), "pi-facade-f5-"));
  workspace = mkdtempSync(path.join(tmpdir(), "pi-facade-f5-ws-"));
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
  // The workspace is an audited git repo from the start.
  await run("git", ["init", "-b", "main"], { cwd: workspace });
  await run("git", ["-C", workspace, "config", "user.name", "test"]);
  await run("git", ["-C", workspace, "config", "user.email", "test@local"]);
  writeFileSync(path.join(workspace, "README.md"), "# audited workspace\n");
  await run("git", ["-C", workspace, "add", "-A"]);
  await run("git", ["-C", workspace, "commit", "-m", "initial"]);
});

after(async () => {
  await stub.close();
});

test("sandbox tiers apply tool allowlists to the live session", async () => {
  const engine = makeEngine({ withTools: true });
  const created = await engine.createSession(workspace);

  const initial = engine.activeTools(created.sessionId);
  assert.ok(initial, "live session reports its tools");
  assert.ok(initial!.includes("bash") && initial!.includes("write"), `defaults include mutating tools: ${initial}`);

  await engine.setSandboxMode(created.sessionId, "read-only");
  const readOnly = engine.activeTools(created.sessionId)!;
  assert.ok(readOnly.includes("read"), "read survives the read-only tier");
  for (const mutating of ["bash", "write", "edit"]) {
    assert.ok(!readOnly.includes(mutating), `read-only tier must drop ${mutating} (got ${readOnly.join(",")})`);
  }

  await engine.setSandboxMode(created.sessionId, "workspace-write");
  const writeable = engine.activeTools(created.sessionId)!;
  assert.ok(writeable.includes("bash") && writeable.includes("write") && writeable.includes("edit"));

  const history = await engine.history(created.sessionId);
  assert.deepEqual(history.projections.values["permissions"], { currentValue: "workspace-write" });
  await engine.release(created.sessionId);
});

test("facade restart: a fresh engine on the same agentDir lists, resumes and keeps history", async () => {
  const engineA = makeEngine();
  const created = await engineA.createSession(workspace);
  await runToSettled(engineA, created.sessionId, "round one");
  await engineA.release(created.sessionId); // simulate the process going away

  // A brand-new engine (same agentDir) is what a facade restart produces.
  const engineB = makeEngine({
    onRunSettled: (info) => {
      void commitWorkspace(info.cwd, info.sessionId);
    },
  });
  const items = await engineB.listSessions();
  assert.ok(items.some((item) => item.sessionId === created.sessionId), "the persisted session is listed");
  assert.equal(items.find((item) => item.sessionId === created.sessionId)?.running, false, "cold after restart");

  // A workspace change made "by the run" must land as one audit commit.
  writeFileSync(path.join(workspace, "run-output.txt"), "produced during round two\n");
  await runToSettled(engineB, created.sessionId, "round two");

  const history = await engineB.history(created.sessionId);
  const users = history.events.filter((e) => e.event.type === "user/message");
  assert.equal(users.length, 2, "both rounds persisted across the restart");

  await waitFor(async () => (await gitLog(workspace)).some((subject) => subject.startsWith("pi run ")));
  const log = await gitLog(workspace);
  assert.equal(log.filter((subject) => subject.startsWith("pi run ")).length, 1, "exactly one audit commit");
  const { stdout } = await run("git", ["-C", workspace, "show", "--stat", "--format=", "HEAD"]);
  assert.ok(stdout.includes("run-output.txt"), "the run's workspace change is in the audit commit");

  // A clean round adds no empty commit.
  await runToSettled(engineB, created.sessionId, "round three");
  await new Promise((resolve) => setTimeout(resolve, 500));
  const logAfter = await gitLog(workspace);
  assert.equal(
    logAfter.filter((subject) => subject.startsWith("pi run ")).length,
    1,
    "a clean run leaves no empty commit",
  );
  await engineB.release(created.sessionId);
});
