/**
 * OpenAI-compatible endpoint synthesis for <agentDir>/models.json.
 *
 * Pi supports any endpoint that speaks a built-in API through models.json
 * (pinned docs models.md §"Configure a compatible endpoint"): a provider entry
 * {baseUrl, api:"openai-completions", apiKey?, models?}. Two upstream facts
 * shape this module:
 *
 * 1. apiKey values accept "$NAME" environment interpolation — so the secret
 *    stays in the process env and never lands on disk (volumes, backups).
 * 2. Registering only baseUrl for an EXISTING provider id (default: "openai")
 *    preserves that provider's built-in catalog models; a `models` entry adds
 *    or replaces the same id. So pointing the stock openai id at a compatible
 *    proxy keeps catalog model ids selectable, while PI_OPENAI_MODELS covers
 *    ids the catalog does not know (vLLM/SGLang deployments, custom aliases).
 *
 * A provider entry already present in the file always wins (explicit file
 * config beats env synthesis); the merge never clobbers foreign providers.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { OpenAiCompatConfig } from "./config.ts";

export interface OpenAiCompatResult {
  /** Whether models.json was (re)written. */
  changed: boolean;
  /** One-line human note for the boot log. */
  note: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const applyOpenAiCompat = (agentDir: string, compat: OpenAiCompatConfig): OpenAiCompatResult => {
  mkdirSync(agentDir, { recursive: true });
  const file = path.join(agentDir, "models.json");

  let root: Record<string, unknown> = {};
  if (existsSync(file)) {
    const raw = readFileSync(file, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`${file} exists but is not valid JSON — refusing to guess`, { cause: error });
    }
    if (!isRecord(parsed)) {
      throw new Error(`${file} must contain a JSON object with a "providers" map`);
    }
    root = parsed;
  }
  const existing = root["providers"];
  if (existing !== undefined && !isRecord(existing)) {
    throw new Error(`${file}: "providers" must be a JSON object`);
  }
  const providers: Record<string, unknown> = { ...(existing ?? {}) };

  if (providers[compat.provider] !== undefined) {
    return {
      changed: false,
      note: `models.json already defines provider "${compat.provider}" — keeping the file entry (file config wins over env synthesis)`,
    };
  }

  const entry: Record<string, unknown> = { baseUrl: compat.baseUrl, api: "openai-completions" };
  if (compat.apiKeyRef !== null) entry["apiKey"] = compat.apiKeyRef;
  if (compat.models.length > 0) entry["models"] = compat.models.map((id) => ({ id }));
  providers[compat.provider] = entry;
  root["providers"] = providers;

  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(root, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
  return {
    changed: true,
    note:
      `synthesized provider "${compat.provider}" in models.json (api openai-completions, baseUrl ${compat.baseUrl}` +
      `${compat.models.length > 0 ? `, models ${compat.models.join(", ")}` : ", built-in catalog models preserved"})`,
  };
};
