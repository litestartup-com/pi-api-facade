/**
 * Git audit hook: per-workspace serialization. Concurrent runs settling on the
 * same workspace must never race the git index (a lost index.lock race drops
 * an audit commit silently — the DSH-node semantics DAC documents as a commit
 * lock). Two concurrent calls with changes for both: nothing throws, and HEAD
 * tracks every file (no lost audit).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { commitWorkspace } from "../src/git-hook.ts";

const run = promisify(execFile);

const initRepo = async (): Promise<string> => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-facade-git-"));
  await run("git", ["init", "-b", "main"], { cwd: dir });
  await run("git", ["-C", dir, "config", "user.name", "test"]);
  await run("git", ["-C", dir, "config", "user.email", "test@local"]);
  writeFileSync(path.join(dir, "seed.txt"), "seed\n");
  await run("git", ["-C", dir, "add", "-A"]);
  await run("git", ["-C", dir, "commit", "-m", "seed"]);
  return dir;
};

test("non-git directories are a silent no-op", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "pi-facade-nogit-"));
  assert.equal(await commitWorkspace(dir, "s1"), false);
});

test("a clean workspace produces no empty commit", async () => {
  const dir = await initRepo();
  assert.equal(await commitWorkspace(dir, "s1"), false);
  const { stdout } = await run("git", ["-C", dir, "rev-list", "--count", "HEAD"]);
  assert.equal(stdout.trim(), "1");
});

test("concurrent commits on one workspace serialize: nothing throws, no audit lost", async () => {
  const dir = await initRepo();
  writeFileSync(path.join(dir, "a.txt"), "A\n");
  const first = commitWorkspace(dir, "aaaa1111");
  writeFileSync(path.join(dir, "b.txt"), "B\n");
  const second = commitWorkspace(dir, "bbbb2222");
  const results = await Promise.all([first, second]);

  // At least one commit landed; both calls are honest booleans, never throws.
  assert.ok(results.every((r) => typeof r === "boolean"));
  assert.ok(results.includes(true), "the pending changes were committed");

  // HEAD tracks both files — the second change was not dropped by an index race.
  const { stdout } = await run("git", ["-C", dir, "ls-files"]);
  const tracked = stdout.split("\n");
  assert.ok(tracked.includes("a.txt"), `a.txt tracked; got ${tracked.join(",")}`);
  assert.ok(tracked.includes("b.txt"), `b.txt tracked; got ${tracked.join(",")}`);

  // The work tree is clean: every change made it into history.
  const status = await run("git", ["-C", dir, "status", "--porcelain"]);
  assert.equal(status.stdout.trim(), "", "no uncommitted leftovers");

  // Commit subjects follow the audit format.
  const log = await run("git", ["-C", dir, "log", "--format=%s"]);
  const audits = log.stdout.split("\n").filter((s) => s.startsWith("pi run "));
  assert.ok(audits.length >= 1);
  assert.match(audits[0]!, /^pi run [0-9a-f]{8} \d{4}-\d{2}-\d{2}T/);
});

test("different workspaces commit independently (lock is per-directory)", async () => {
  const dirA = await initRepo();
  const dirB = await initRepo();
  writeFileSync(path.join(dirA, "x.txt"), "X\n");
  writeFileSync(path.join(dirB, "y.txt"), "Y\n");
  const [ra, rb] = await Promise.all([commitWorkspace(dirA, "sa"), commitWorkspace(dirB, "sb")]);
  assert.equal(ra, true);
  assert.equal(rb, true);
});
