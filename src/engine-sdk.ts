/**
 * SdkPiEngine — the v1 southbound: Pi's TypeScript SDK embedded in the facade
 * process. One engine hosts every session of one node concurrently;
 * upstream-verified: Pi's run mutex is per-Agent-instance, so per-session
 * Agent instances never block each other.
 *
 * Isolation: all Pi state lives under `agentDir` (auth.json, models.json,
 * settings, and this engine's sessionDir = <agentDir>/sessions). Sessions are
 * always created with an explicit SessionManager bound to that directory —
 * the SDK default would escape to the process-global ~/.pi/agent.
 */
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  VERSION,
  type AgentSession,
  type ExtensionAPI,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import {
  EngineError,
  type ApprovalGate,
  type EngineCreatedSession,
  type EngineHistory,
  type EngineHostInfo,
  type EngineListener,
  type EngineModelCatalog,
  type EngineModelSelection,
  type EngineSessionItem,
  type MuxPayload,
  type PiEngine,
  type SandboxMode,
} from "./engine.ts";
import { historyEntriesToEvents, projectionsFromEntries, SessionTranslator } from "./translate-pi.ts";

export interface SdkEngineOptions {
  /** Per-node Pi agent home (auth/models/settings live here; sessions under <agentDir>/sessions). */
  agentDir: string;
  allowFullAccess: boolean;
  /** Default model for new sessions ("provider" + "model" ids). Omit = first available. */
  defaultModel?: { provider: string; model: string };
  /** Tool suppression passed to createAgentSession (tests run "all"; production leaves built-ins on). */
  noTools?: "all" | "builtin";
  /** Set false to block catalog network refresh (offline CI). */
  allowModelNetwork?: boolean;
  /** Operator approval bridge; consulted for every tool call of danger-full-access sessions. */
  approvalGate?: ApprovalGate;
  /** Fires after a run fully settles (agent_settled) — the git-commit hook hangs here. */
  onRunSettled?: (info: { sessionId: string; cwd: string }) => void;
}

/**
 * Per-tier tool allowlists (contract-map §12). Pi has no path sandbox, so the
 * read-only tier drops every mutating tool (bash included — it cannot be
 * constrained); the containerized node form provides the real mount boundary.
 */
const TIER_TOOLS: Record<SandboxMode, string[]> = {
  "read-only": ["read", "grep", "find", "ls"],
  "workspace-write": ["read", "grep", "find", "ls", "bash", "edit", "write"],
  "danger-full-access": ["read", "grep", "find", "ls", "bash", "edit", "write"],
};

type PiModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

interface LiveSession {
  session: AgentSession;
  translator: SessionTranslator;
  unsubscribe: () => void;
  cwd: string;
}

const rec = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const numOf = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export class SdkPiEngine implements PiEngine {
  private readonly options: SdkEngineOptions;
  private readonly sessionDir: string;
  private readonly live = new Map<string, LiveSession>();
  private readonly attaching = new Map<string, Promise<LiveSession>>();
  private readonly promptChains = new Map<string, Promise<void>>();
  private readonly listeners = new Map<string, Set<EngineListener>>();
  private readonly globalListeners = new Set<EngineListener>();
  private readonly modelOverrides = new Map<string, EngineModelSelection>();
  private readonly tiers = new Map<string, SandboxMode>();
  private runtimePromise: Promise<ModelRuntime> | null = null;

  constructor(options: SdkEngineOptions) {
    this.options = options;
    this.sessionDir = path.join(options.agentDir, "sessions");
  }

  // ---- PiEngine: session lifecycle ----

  async createSession(cwd: string, preset?: string | null): Promise<EngineCreatedSession> {
    if (typeof cwd !== "string" || cwd === "") throw new EngineError("invalid_params", "cwd is required");
    // Explicit SessionManager: keeps session files under THIS node's agentDir.
    const sessionManager = SessionManager.create(cwd, this.sessionDir);
    const live = await this.attach(cwd, sessionManager, null);
    return {
      sessionId: live.session.sessionId,
      agentPreset: preset ?? null,
      provider: live.session.model?.provider ?? null,
      model: live.session.model?.id ?? null,
    };
  }

  async prompt(sessionId: string, text: string): Promise<{ accepted: boolean }> {
    await this.ensureLive(sessionId);
    // Issue serially per session: two prompts racing the same AgentSession hit
    // Pi's instance mutex ("already processing a prompt") before isStreaming
    // flips, and the loser's message would be dropped. The manager serializes
    // per session anyway; the chain makes the invariant local. accepted:true is
    // returned immediately (queued semantics); frames flow on the mux.
    const previous = this.promptChains.get(sessionId) ?? Promise.resolve();
    const next = previous.then(
      () => this.issuePrompt(sessionId, text),
      () => this.issuePrompt(sessionId, text),
    );
    this.promptChains.set(sessionId, next);
    const cleanup = (): void => {
      if (this.promptChains.get(sessionId) === next) this.promptChains.delete(sessionId);
    };
    void next.then(cleanup, cleanup);
    return { accepted: true };
  }

  private async issuePrompt(sessionId: string, text: string): Promise<void> {
    // Re-read the live entry: the session may have been released and re-attached
    // while this prompt was queued.
    const live = this.live.get(sessionId);
    if (live === undefined) {
      console.warn(`prompt for ${sessionId} dropped: the session was released while queued`);
      return;
    }
    const options = live.session.isIdle ? {} : { streamingBehavior: "followUp" as const };
    try {
      await live.session.prompt(text, options);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const wire of live.translator.failTurn(message)) this.emitEvent(sessionId, wire);
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const live = this.live.get(sessionId);
    if (live !== undefined) await live.session.abort();
    // Cold session: nothing is running; the receipt stays ok.
  }

  async release(sessionId: string): Promise<void> {
    const live = this.live.get(sessionId);
    if (live === undefined) return;
    this.live.delete(sessionId);
    live.unsubscribe();
    live.session.dispose();
  }

  // ---- PiEngine: reads ----

  async history(sessionId: string): Promise<EngineHistory> {
    const live = this.live.get(sessionId);
    let filePath = live?.session.sessionFile;
    if (filePath === undefined) {
      const info = await this.findSession(sessionId);
      if (info === null) throw new EngineError("session_not_found", `unknown session ${sessionId}`);
      filePath = info.path;
    }
    const manager = SessionManager.open(filePath, this.sessionDir);
    const entries = manager.getEntries();
    const events = historyEntriesToEvents(entries);
    const projected = projectionsFromEntries(entries);

    const values: Record<string, unknown> = {};
    if (projected.title !== null) values["title"] = projected.title;
    if (live !== undefined) {
      const pressure = this.contextPressure(live);
      if (pressure !== null) values["contextPressure"] = pressure;
    }
    const liveModel = live?.session.model;
    if (liveModel !== undefined) values["modelSelection"] = { next: { provider: liveModel.provider, model: liveModel.id } };
    else if (projected.model !== null) values["modelSelection"] = { next: projected.model };
    values["permissions"] = { currentValue: this.sandboxTier(sessionId) };

    return {
      events: events.map((event) => ({ event, view: null })),
      hasMore: false,
      projections: { asOfSeq: events.length > 0 ? events[events.length - 1]!.seq : 0, values },
    };
  }

  async listSessions(): Promise<EngineSessionItem[]> {
    const infos = await SessionManager.listAll(this.sessionDir);
    return infos.map((info: SessionInfo) => ({
      sessionId: info.id,
      updatedAt: info.modified.getTime(),
      running: this.live.has(info.id),
      blank: info.messageCount === 0,
      projections: { values: info.name !== undefined && info.name !== "" ? { title: info.name } : {} },
    }));
  }

  async models(): Promise<EngineModelCatalog> {
    const runtime = await this.ensureRuntime();
    const available = await runtime.getAvailable();
    const groups = new Map<string, Array<{ id: string; name: string }>>();
    for (const model of available) {
      const provider = String(model.provider);
      const list = groups.get(provider) ?? [];
      list.push({ id: String(model.id), name: String(model.name ?? model.id) });
      groups.set(provider, list);
    }
    const first = available[0];
    const fallback = first !== undefined ? { provider: String(first.provider), model: String(first.id) } : null;
    const wanted = this.options.defaultModel ?? null;
    const current =
      wanted !== null && available.some((m) => String(m.provider) === wanted.provider && String(m.id) === wanted.model)
        ? { provider: wanted.provider, model: wanted.model }
        : fallback;
    return {
      current,
      routable: available.length > 0,
      groups: [...groups.entries()].map(([id, models]) => ({ id, name: id, models })),
      failures: [],
    };
  }

  async selectModel(sessionId: string, selection: EngineModelSelection): Promise<EngineModelSelection> {
    const runtime = await this.ensureRuntime();
    const model = runtime.getModel(selection.provider, selection.model);
    if (model === undefined) {
      throw new EngineError("model_not_found", `unknown model ${selection.provider}/${selection.model}`);
    }
    this.modelOverrides.set(sessionId, { ...selection });
    const live = this.live.get(sessionId);
    if (live !== undefined) await live.session.setModel(model);
    return { ...selection };
  }

  hostDescribe(): EngineHostInfo {
    return {
      protocol: "0.0.1",
      runtime: "pi",
      version: `pi-${VERSION}`,
      allowFullAccess: this.options.allowFullAccess,
    };
  }

  // ---- PiEngine: live frames ----

  subscribe(sessionId: string, listener: EngineListener): () => void {
    const set = this.listeners.get(sessionId) ?? new Set<EngineListener>();
    set.add(listener);
    this.listeners.set(sessionId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(sessionId);
    };
  }

  subscribeAll(listener: EngineListener): () => void {
    this.globalListeners.add(listener);
    return () => {
      this.globalListeners.delete(listener);
    };
  }

  async setSandboxMode(sessionId: string, mode: SandboxMode): Promise<void> {
    const live = this.live.get(sessionId);
    if (live === undefined) {
      throw new EngineError("session_not_live", `session ${sessionId} is not live`);
    }
    if (mode === "danger-full-access" && !this.options.allowFullAccess) {
      throw new EngineError("full_access_locked", "node has not unlocked danger-full-access");
    }
    this.tiers.set(sessionId, mode);
    // Apply the tier's tool allowlist immediately; Pi declares the change to
    // the model before the next request (no mid-stream mutation hazard: the
    // manager pins the mode before the first prompt).
    live.session.setActiveToolsByName([...TIER_TOOLS[mode]]);
  }

  activeTools(sessionId: string): string[] | null {
    const live = this.live.get(sessionId);
    return live !== undefined ? live.session.getActiveToolNames() : null;
  }

  // ---- internals ----

  private emitEvent(sessionId: string, event: { type: string; seq: number; data: Record<string, unknown> }): void {
    const payload: MuxPayload = { type: "session/event", sessionId, event, view: null };
    for (const listener of this.listeners.get(sessionId) ?? []) listener(payload);
    for (const listener of this.globalListeners) listener(payload);
  }

  private tierOf(sessionId: string): SandboxMode {
    return this.tiers.get(sessionId) ?? "workspace-write";
  }

  private ensureRuntime(): Promise<ModelRuntime> {
    if (this.runtimePromise === null) {
      this.runtimePromise = ModelRuntime.create({
        authPath: path.join(this.options.agentDir, "auth.json"),
        modelsPath: path.join(this.options.agentDir, "models.json"),
        allowModelNetwork: this.options.allowModelNetwork ?? true,
      });
    }
    return this.runtimePromise;
  }

  private async resolveModel(override: EngineModelSelection | null): Promise<PiModel> {
    const runtime = await this.ensureRuntime();
    if (override !== null) {
      const model = runtime.getModel(override.provider, override.model);
      if (model !== undefined) return model;
    }
    if (this.options.defaultModel !== undefined) {
      const model = runtime.getModel(this.options.defaultModel.provider, this.options.defaultModel.model);
      if (model !== undefined) return model;
      throw new EngineError(
        "model_not_found",
        `default model ${this.options.defaultModel.provider}/${this.options.defaultModel.model} is not available (provider auth or models.json?)`,
      );
    }
    const available = await runtime.getAvailable();
    const first = available[0];
    if (first === undefined) throw new EngineError("no_model", "no provider model available (no credentials?)");
    return first;
  }

  private async attach(cwd: string, sessionManager: SessionManager, sessionIdForOverride: string | null): Promise<LiveSession> {
    const model = await this.resolveModel(sessionIdForOverride !== null ? this.modelOverrides.get(sessionIdForOverride) ?? null : null);
    const runtime = await this.ensureRuntime();

    // The approval bridge is an inline extension: Pi's tool_call hook can
    // block a call until the operator decides (upstream-verified block
    // semantics). The gate only fires for danger-full-access sessions; every
    // other tier runs tools directly.
    const gate = this.options.approvalGate;
    const holder: { sessionId: string | null } = { sessionId: null };
    const tierOf = (sessionId: string): SandboxMode => this.tierOf(sessionId);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: this.options.agentDir,
      ...(gate !== undefined
        ? {
            extensionFactories: [
              {
                name: "dac-approval-gate",
                hidden: true,
                factory: (pi: ExtensionAPI): void => {
                  pi.on("tool_call", async (event) => {
                    const sessionId = holder.sessionId;
                    if (sessionId === null || tierOf(sessionId) !== "danger-full-access") return {};
                    const outcome = await gate({
                      sessionId,
                      approvalId: event.toolCallId,
                      toolName: event.toolName,
                      callId: event.toolCallId,
                      reason: summarizeInput(event.input),
                    });
                    if (outcome === "allowed-once") return {};
                    const reason =
                      outcome === "unavailable"
                        ? "no operator was available to approve this tool call"
                        : `the operator ${outcome} this tool call`;
                    return { block: true, reason };
                  });
                },
              },
            ],
          }
        : {}),
    });
    await resourceLoader.reload();

    const { session } = await createAgentSession({
      cwd,
      agentDir: this.options.agentDir,
      modelRuntime: runtime,
      model,
      thinkingLevel: "off",
      sessionManager,
      resourceLoader,
      ...(this.options.noTools !== undefined ? { noTools: this.options.noTools } : {}),
    });
    holder.sessionId = session.sessionId;
    const translator = new SessionTranslator();
    const onSettled = this.options.onRunSettled;
    const unsubscribe = session.subscribe((event) => {
      for (const wire of translator.onEvent(event as unknown)) this.emitEvent(session.sessionId, wire);
      if (onSettled !== undefined && (event as { type?: unknown }).type === "agent_settled") {
        onSettled({ sessionId: session.sessionId, cwd });
      }
    });
    const live: LiveSession = { session, translator, unsubscribe, cwd };
    this.live.set(session.sessionId, live);
    return live;
  }

  private async ensureLive(sessionId: string): Promise<LiveSession> {
    const existing = this.live.get(sessionId);
    if (existing !== undefined) return existing;
    // In-flight guard: two concurrent prompts on the same cold session must
    // attach exactly once — a second AgentSession on the same JSONL file would
    // corrupt the audit trail. The manager serializes prompts per session, but
    // the invariant is enforced here regardless.
    const inflight = this.attaching.get(sessionId);
    if (inflight !== undefined) return inflight;
    const task = (async (): Promise<LiveSession> => {
      const info = await this.findSession(sessionId);
      if (info === null) throw new EngineError("session_not_found", `unknown session ${sessionId}`);
      const cwd = info.cwd !== "" ? info.cwd : process.cwd();
      // SessionManager.open replays the persisted tree; createAgentSession
      // rebuilds the model context from it — the upstream-verified cold-resume
      // path.
      const sessionManager = SessionManager.open(info.path, this.sessionDir, cwd);
      return this.attach(cwd, sessionManager, sessionId);
    })();
    this.attaching.set(sessionId, task);
    try {
      return await task;
    } finally {
      if (this.attaching.get(sessionId) === task) this.attaching.delete(sessionId);
    }
  }

  private async findSession(sessionId: string): Promise<SessionInfo | null> {
    const infos = await SessionManager.listAll(this.sessionDir);
    return infos.find((info) => info.id === sessionId) ?? null;
  }

  /** Best-effort context pressure from live stats (the manager renders used/window %). */
  private contextPressure(live: LiveSession): { projectedTokens: number; contextWindow: number } | null {
    const stats = rec(live.session.getSessionStats());
    const usage = rec(stats?.["contextUsage"]);
    const model = rec(live.session.model);
    const contextWindow =
      numOf(usage?.["contextWindow"]) ?? numOf(model?.["contextWindow"]) ?? null;
    const tokens = rec(stats?.["tokens"]);
    const projectedTokens =
      numOf(usage?.["projectedTokens"]) ??
      numOf(usage?.["usedTokens"]) ??
      numOf(usage?.["tokens"]) ??
      ((numOf(tokens?.["input"]) ?? 0) + (numOf(tokens?.["output"]) ?? 0) > 0
        ? (numOf(tokens?.["input"]) ?? 0) + (numOf(tokens?.["output"]) ?? 0)
        : undefined);
    if (contextWindow === null || projectedTokens === undefined) return null;
    return { projectedTokens, contextWindow };
  }

  /** The session's pinned tier; workspace-write is the honest default (F5 owns provisioning). */
  private sandboxTier(sessionId: string): SandboxMode {
    return this.tierOf(sessionId);
  }
}

const summarizeInput = (input: unknown): string => {
  try {
    const serialized = JSON.stringify(input ?? {});
    return serialized.length > 300 ? `${serialized.slice(0, 300)}…` : serialized;
  } catch {
    return "[unserializable tool input]";
  }
};
