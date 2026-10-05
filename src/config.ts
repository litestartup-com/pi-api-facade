/**
 * Runtime configuration, sourced exclusively from environment variables.
 *
 * The facade is a per-node process: one facade owns one Pi agent home
 * (`agentDir`) and every session on that node. All knobs are env-driven so
 * the DAC manager / node-agent can provision nodes without touching files.
 */
import os from "node:os";
import path from "node:path";

export interface FacadeConfig {
  /** Interface to bind. Defaults to loopback; exposing is an ops decision. */
  readonly host: string;
  readonly port: number;
  /** Route prefix mirroring the frozen contract (dsh-api-gateway default). */
  readonly prefix: string;
  /** Pi agent home (auth.json / models.json / settings.json / sessions). Per-node isolation. */
  readonly agentDir: string;
  /** Whether the danger-full-access sandbox tier is unlocked on this node. */
  readonly allowFullAccess: boolean;
  /** Pre-seeded API keys (comma-separated env). Empty = every authenticated call is rejected (fail closed). */
  readonly apiKeys: readonly string[];
  /** OpenAI-compatible endpoint synthesis (null when PI_OPENAI_BASE_URL is unset). */
  readonly openaiCompat: OpenAiCompatConfig | null;
}

/**
 * Env-driven adapter for any endpoint speaking the OpenAI chat-completions API
 * (OpenAI itself, OneAPI/new-api style proxies, vLLM, SGLang, Ollama, ...).
 * Boot synthesizes a models.json provider entry from it — see openai-compat.ts
 * and the pinned Pi docs (models.md §"Configure a compatible endpoint").
 */
export interface OpenAiCompatConfig {
  readonly baseUrl: string;
  /**
   * "$PI_OPENAI_API_KEY" when the key env is set (Pi interpolates at request
   * time — the secret never touches disk); null omits the field so Pi's native
   * credential fallbacks (auth.json, OPENAI_API_KEY env) stay in charge.
   */
  readonly apiKeyRef: string | null;
  /** Provider id to synthesize/override. Default "openai" keeps the built-in catalog's model ids usable. */
  readonly provider: string;
  /** Extra model ids to add/replace on that provider (required in practice for non-built-in ids). */
  readonly models: readonly string[];
}

const boolOf = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined || value === "") return fallback;
  return value === "1" || value.toLowerCase() === "true";
};

export const loadConfig = (
  env: Record<string, string | undefined> = process.env,
): FacadeConfig => {
  const portRaw = env["PI_FACADE_PORT"] ?? "3091";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PI_FACADE_PORT must be an integer in 0..65535, got: ${portRaw}`);
  }
  const prefix = env["PI_FACADE_PREFIX"] ?? "/api-gw/v1";
  if (!prefix.startsWith("/") || prefix.length < 2) {
    throw new Error(`PI_FACADE_PREFIX must start with "/" and be non-trivial, got: ${prefix}`);
  }
  return {
    host: env["PI_FACADE_HOST"] ?? "127.0.0.1",
    port,
    prefix: prefix.replace(/\/+$/, ""),
    agentDir: env["PI_AGENT_DIR"] ?? path.join(os.homedir(), ".pi", "agent"),
    allowFullAccess: boolOf(env["PI_FACADE_ALLOW_FULL_ACCESS"], false),
    apiKeys: (env["PI_FACADE_API_KEYS"] ?? "")
      .split(",")
      .map((key) => key.trim())
      .filter((key) => key !== ""),
    openaiCompat: parseOpenAiCompat(env),
  };
};

const parseOpenAiCompat = (env: Record<string, string | undefined>): OpenAiCompatConfig | null => {
  const baseUrl = env["PI_OPENAI_BASE_URL"] ?? "";
  if (baseUrl === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`PI_OPENAI_BASE_URL must be an absolute http(s) URL, got: ${baseUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`PI_OPENAI_BASE_URL must be http(s), got: ${baseUrl}`);
  }
  const provider = env["PI_OPENAI_PROVIDER"] ?? "openai";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(provider)) {
    throw new Error(`PI_OPENAI_PROVIDER must be a plain identifier (letters/digits/._-, no slashes), got: ${provider}`);
  }
  return {
    baseUrl,
    apiKeyRef: (env["PI_OPENAI_API_KEY"] ?? "") !== "" ? "$PI_OPENAI_API_KEY" : null,
    provider,
    models: (env["PI_OPENAI_MODELS"] ?? "")
      .split(",")
      .map((model) => model.trim())
      .filter((model) => model !== ""),
  };
};
