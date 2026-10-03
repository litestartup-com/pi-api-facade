/**
 * Per-run git commit hook (the DAC audit discipline: every run leaves one
 * commit in the workspace repo). Hung on the engine's agent_settled callback;
 * every failure is logged and swallowed — a broken hook must never block chat.
 *
 * Commits are serialized per workspace directory (the DSH-node "git commit
 * lock" semantics): concurrent runs settling on the same workspace would
 * otherwise race the git index and silently drop an audit commit.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const run = promisify(execFile);

const git = async (cwd: string, args: string[]): Promise<{ code: number; stdout: string }> => {
  try {
    const { stdout } = await run("git", args, { cwd, timeout: 60_000, windowsHide: true });
    return { code: 0, stdout: stdout.trim() };
  } catch (error) {
    const err = error as { code?: number; stdout?: string };
    return { code: typeof err.code === "number" ? err.code : 1, stdout: (err.stdout ?? "").toString().trim() };
  }
};

/**
 * Commits everything under `cwd` when it is a git work tree with staged-able
 * changes. Identity is forced per-invocation so the hook works in containers
 * without global git config. Returns true when a commit was created.
 * Concurrent calls on the same directory run back to back.
 */
export const commitWorkspace = (cwd: string, sessionId: string): Promise<boolean> => {
  const key = path.resolve(cwd);
  const previous = locks.get(key) ?? Promise.resolve(false);
  const next = previous.then(
    () => doCommit(cwd, sessionId),
    () => doCommit(cwd, sessionId),
  );
  locks.set(key, next);
  void next.then(
    () => {
      if (locks.get(key) === next) locks.delete(key);
    },
    () => {
      if (locks.get(key) === next) locks.delete(key);
    },
  );
  return next;
};

/** The per-directory commit chain (values are settled-safe; doCommit never rejects). */
const locks = new Map<string, Promise<boolean>>();

const doCommit = async (cwd: string, sessionId: string): Promise<boolean> => {
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.stdout !== "true") return false;

  const add = await git(cwd, ["add", "-A"]);
  if (add.code !== 0) {
    console.error(`git-hook: add failed in ${cwd}: exit ${add.code}`);
    return false;
  }
  const dirty = await git(cwd, ["diff", "--cached", "--quiet"]);
  if (dirty.code === 0) return false; // nothing to commit — a clean run is not an empty commit

  const message = `pi run ${sessionId.slice(0, 8)} ${new Date().toISOString()}`;
  const commit = await git(cwd, [
    "-c", "user.name=pi-api-facade",
    "-c", "user.email=pi-api-facade@localhost",
    "commit", "-m", message,
  ]);
  if (commit.code !== 0) {
    console.error(`git-hook: commit failed in ${cwd}: exit ${commit.code}`);
    return false;
  }
  return true;
};
