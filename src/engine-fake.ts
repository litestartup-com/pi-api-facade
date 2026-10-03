/**
 * In-memory PiEngine for tests and explicit development runs. Deterministic
 * usage numbers, no Pi SDK, no network. Never usable for production: index.ts
 * refuses to boot without PI_FACADE_ENGINE=fake and prints a warning with it.
 */
import { randomUUID } from "node:crypto";
import {
  EngineError,
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

interface FakeSession {
  id: string;
  cwd: string;
  seq: number;
  model: EngineModelSelection;
  events: EngineHistory["events"];
  createdAt: number;
}

const STATIC_MODELS: Array<{ id: string; name: string }> = [
  { id: "deepseek-flash", name: "DeepSeek Flash" },
  { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
];

export class FakePiEngine implements PiEngine {
  private readonly sessions = new Map<string, FakeSession>();
  private readonly listeners = new Map<string, Set<EngineListener>>();
  private readonly globalListeners = new Set<EngineListener>();
  private readonly tiers = new Map<string, SandboxMode>();
  private readonly hostInfo: EngineHostInfo;

  constructor(host?: { version?: string; allowFullAccess?: boolean }) {
    this.hostInfo = {
      protocol: "0.0.1",
      runtime: "pi",
      version: host?.version ?? "pi-fake",
      allowFullAccess: host?.allowFullAccess ?? false,
    };
  }

  async createSession(cwd: string, preset?: string | null): Promise<EngineCreatedSession> {
    const id = randomUUID();
    const model: EngineModelSelection = { provider: "deepseek", model: "deepseek-flash" };
    this.sessions.set(id, { id, cwd, seq: 0, model, events: [], createdAt: Date.now() });
    return { sessionId: id, agentPreset: preset ?? null, provider: model.provider, model: model.model };
  }

  async prompt(sessionId: string, text: string): Promise<{ accepted: boolean }> {
    const session = this.mustGet(sessionId);
    const nextSeq = (): number => ++session.seq;
    const appended: EngineHistory["events"] = [
      { event: { type: "user/message", seq: nextSeq(), data: { id: randomUUID(), content: [{ type: "text", text }] } }, view: null },
      { event: { type: "turn/start", seq: nextSeq(), data: { turn: 1 } }, view: null },
      {
        event: {
          type: "assistant/message",
          seq: nextSeq(),
          data: {
            message: { content: [{ type: "text", text: `fake:${text}` }] },
            usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
          },
        },
        view: null,
      },
      { event: { type: "turn/end", seq: nextSeq(), data: { turn: 1, reason: { kind: "completed" } } }, view: null },
    ];
    session.events.push(...appended);
    for (const item of appended) {
      this.emit(sessionId, { type: "session/event", sessionId, event: item.event, view: item.view });
    }
    return { accepted: true };
  }

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
    if (!this.sessions.has(sessionId)) {
      throw new EngineError("session_not_live", `session ${sessionId} is not live`);
    }
    if (mode === "danger-full-access" && !this.hostInfo.allowFullAccess) {
      throw new EngineError("full_access_locked", "node has not unlocked danger-full-access");
    }
    this.tiers.set(sessionId, mode);
  }

  async release(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    this.listeners.delete(sessionId);
    this.tiers.delete(sessionId);
  }

  private emit(sessionId: string, payload: MuxPayload): void {
    for (const listener of this.listeners.get(sessionId) ?? []) listener(payload);
    for (const listener of this.globalListeners) listener(payload);
  }

  async cancel(sessionId: string): Promise<void> {
    this.mustGet(sessionId);
  }

  async history(sessionId: string): Promise<EngineHistory> {
    const session = this.mustGet(sessionId);
    return {
      events: session.events,
      hasMore: false,
      projections: {
        asOfSeq: session.seq,
        values: {
          title: session.events.length === 0 ? null : `fake ${session.id.slice(0, 8)}`,
          contextPressure: { projectedTokens: 15, contextWindow: 1_000_000 },
          modelSelection: { next: session.model },
          permissions: { currentValue: this.tiers.get(sessionId) ?? "workspace-write" },
        },
      },
    };
  }

  async listSessions(): Promise<EngineSessionItem[]> {
    return [...this.sessions.values()].map((session) => ({
      sessionId: session.id,
      updatedAt: session.createdAt,
      running: false,
      blank: session.events.length === 0,
      projections: { values: {} },
    }));
  }

  async models(): Promise<EngineModelCatalog> {
    return {
      current: { provider: "deepseek", model: "deepseek-flash" },
      routable: true,
      groups: [{ id: "deepseek", name: "DeepSeek", models: STATIC_MODELS }],
      failures: [],
    };
  }

  async selectModel(sessionId: string, selection: EngineModelSelection): Promise<EngineModelSelection> {
    const session = this.mustGet(sessionId);
    const known = STATIC_MODELS.some((m) => m.id === selection.model);
    if (selection.provider !== "deepseek" || !known) {
      throw new EngineError("model_not_found", `unknown model ${selection.provider}/${selection.model}`);
    }
    session.model = { ...selection };
    return { ...selection };
  }

  hostDescribe(): EngineHostInfo {
    return { ...this.hostInfo };
  }

  private mustGet(sessionId: string): FakeSession {
    const session = this.sessions.get(sessionId);
    if (session === undefined) throw new EngineError("session_not_found", `unknown session ${sessionId}`);
    return session;
  }
}
