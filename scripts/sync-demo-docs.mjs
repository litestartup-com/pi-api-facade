/**
 * Syncs this repo's user-facing docs into examples/demos/seed-docs/ — the KB
 * Studio demo seeds its content/docs/ area from SEED_DOCS at boot, and on the
 * Pi stack the knowledge base IS this project's documentation (the same
 * self-hosting pattern the gateway demos use). The output directory is a
 * gitignored build artifact; run this before `docker compose up` with the
 * demos overlay (CI does it too).
 */
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(repo, "examples", "demos", "seed-docs");

/** Repo-relative sources → KB file names (flat; dot prefix stripped by the BFF anyway). */
const files = [
  ["README.md", "README.md"],
  ["README.zh.md", "README.zh.md"],
  ["openapi.yaml", "openapi.yaml"],
  ["docker-compose.yml", "docker-compose.yml"],
  [".env.example", "env.example"],
  ["docs/runbook.md", "runbook.md"],
  ["docs/contract-map.md", "contract-map.md"],
];

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const [src, dst] of files) {
  copyFileSync(join(repo, src), join(out, dst));
  console.log(`seed-docs: ${src} -> ${dst}`);
}
console.log(`seed-docs: ${files.length} file(s) synced into ${out}`);
