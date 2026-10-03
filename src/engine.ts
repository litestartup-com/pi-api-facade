/**
 * PiEngine — the narrow southbound port. Everything Pi-specific lives behind
 * this interface; the HTTP contract layer never imports the Pi SDK directly.
 * v1 implementation: SdkPiEngine (in-process createAgentSession, phase F3).
 * Documented fallback (not built): an RPC-child engine. Tests use FakePiEngine.
 */

/** Bare session event as it travels inside session/event frames (contract-map §8). */
export interface EngineHistoryEvent {
  type: string;
  seq: number;
  data: Record<string, unknown>;
}

export interface EngineHistory {
  events: Array<{ event: EngineHistoryEvent; view: unknown }>;
  hasMore: boolean;
  projections: { asOfSeq: number; values: Record<string, unknown> };
}

export interface EngineSessionItem {
  sessionId: string;
  updatedAt: number | null;
  running: boolean;
  blank: boolean;
  projections: { values: { title?: string } };
}

export interface EngineModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface EngineModelCatalog {
  current: EngineModelSelection | null;
  routable: boolean;
  groups: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>;
  failures: Array<{ id: string; name: string; message: string }>;
}

export interface EngineCreatedSession {
  sessionId: string;
  agentPreset: string | null;
  provider: string | null;
  model: string | null;
}

export interface EngineHostInfo {
  protocol: string;
  runtime: string;
  version: string;
  allowFullAccess: boolean;
}

/** Business error with a wire code; the proxy route maps it to result.ok=false. */
export class EngineError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EngineError";
    this.code = code;
  }
}

/**
 * Mux payload frames the engine produces (contract-map §4). F4 wraps these in
 * server-request envelopes and broadcasts them on events.mux. The payload set
 * is the closed union the manager accepts; the engine never emits anything else.
 */
export interface SessionEventPayload {
  type: "session/event";
  sessionId: string;
  event: EngineHistoryEvent;
  view?: unknown;
}

export interface SessionProjectionPayload {
  type: "session/projection";
  sessionId: string;
  key: string;
  value: unknown;
  seq?: number;
}

export interface ApprovalRequestedPayload {
  type: "approval/requested";
  sessionId: string;
  approvalId: string;
  toolName: string;
  callId: string | null;
  reason: string | null;
}

export interface ApprovalResolvedPayload {
  type: "approval/resolved";
  sessionId: string;
  approvalId: string;
  outcome: string;
}

/**
 * The closed payload set this facade emits (contract-map §4). Question cards
 * are deliberately absent: Pi has no question surface in v1.
 */
export type MuxPayload =
  | SessionEventPayload
  | SessionProjectionPayload
  | ApprovalRequestedPayload
  | ApprovalResolvedPayload;

export type EngineListener = (payload: MuxPayload) => void;

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

/** One pending operator decision for a tool call (contract-map §4/§10). */
export interface ApprovalRequest {
  sessionId: string;
  approvalId: string;
  toolName: string;
  callId: string | null;
  reason: string | null;
}

export type ApprovalOutcome = "allowed-once" | "rejected" | "expired";

/** Injected by the facade layer (CardTable): resolves when the operator decides or the card TTL expires. */
export type ApprovalGate = (request: ApprovalRequest) => Promise<ApprovalOutcome>;

export interface PiEngine {
  createSession(cwd: string, preset?: string | null): Promise<EngineCreatedSession>;
  /** Also serves as cold-session attach/resume (contract-map §3). */
  prompt(sessionId: string, text: string): Promise<{ accepted: boolean }>;
  cancel(sessionId: string): Promise<void>;
  history(sessionId: string): Promise<EngineHistory>;
  listSessions(): Promise<EngineSessionItem[]>;
  models(): Promise<EngineModelCatalog>;
  selectModel(sessionId: string, selection: EngineModelSelection): Promise<EngineModelSelection>;
  hostDescribe(): EngineHostInfo;
  /** Live frame subscription; works for cold sessions too (fires once resumed). Returns an unsubscribe function. */
  subscribe(sessionId: string, listener: EngineListener): () => void;
  /** Node-wide tap: every session's frames (the mux is a full-volume broadcast). */
  subscribeAll(listener: EngineListener): () => void;
  /** Pins the per-session sandbox tier. Live sessions only: cold → EngineError "session_not_live". */
  setSandboxMode(sessionId: string, mode: SandboxMode): Promise<void>;
  /** Introspection (ops/tests): the tool names active on a live session; null when cold/unknown. */
  activeTools?(sessionId: string): string[] | null;
  /** Disposes live session state (Pi keeps the JSONL file; a later prompt reopens it). */
  release(sessionId: string): Promise<void>;
}
