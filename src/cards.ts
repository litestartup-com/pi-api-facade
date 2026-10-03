/**
 * CardTable — the pending question/approval registry behind respond and
 * answerer/pending (contract-map §10/§11).
 *
 * A card is minted with a facade rpcId, broadcast once on the mux (with that
 * rpcId in the envelope), and waits for the manager's respond. Matching is
 * strict: rpcId finds the card, then the identity fields must name exactly
 * that request (sessionId + approvalId for approvals, sessionId + the answers
 * shape for questions) — anything else is "not-pending", never a guess. Cards
 * expire after a TTL so a wedged operator UI cannot pin a run forever; the
 * manager's own backstop is 15 minutes, so the facade TTL matches it.
 */
import type {
  ApprovalOutcome,
  ApprovalRequest,
  ApprovalRequestedPayload,
  MuxPayload,
  QuestionAnswerItem,
  QuestionRequest,
  QuestionResolution,
} from "./engine.ts";

export interface RespondOk {
  ok: true;
  value: unknown;
}
export interface RespondErr {
  ok: false;
  error: { code: string; message: string; details?: unknown };
}
export type RespondResult = RespondOk | RespondErr;

export interface RpcReceipt {
  accepted: boolean;
  reason?: "not-pending" | "bad-response";
}

export interface PendingCardEntry {
  rpcId: string;
  method: "approval/requested" | "question/requested";
  payload: Record<string, unknown>;
}

interface PendingBase {
  rpcId: string;
  sessionId: string;
  payload: Record<string, unknown>;
  timer: NodeJS.Timeout;
}

interface PendingApproval extends PendingBase {
  kind: "approval";
  approvalId: string;
  resolve: (outcome: ApprovalOutcome) => void;
}

interface PendingQuestion extends PendingBase {
  kind: "question";
  resolve: (resolution: QuestionResolution) => void;
}

type PendingCard = PendingApproval | PendingQuestion;

export const CARD_TTL_MS = 15 * 60_000;

const rec = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

export class CardTable {
  private readonly pending = new Map<string, PendingCard>();
  private readonly broadcast: (payload: MuxPayload, rpcId: string) => void;
  private readonly ttlMs: number;
  private seq = 0;

  constructor(broadcast: (payload: MuxPayload, rpcId: string) => void, ttlMs: number = CARD_TTL_MS) {
    this.broadcast = broadcast;
    this.ttlMs = ttlMs;
  }

  /** Mints + broadcasts an approval card and waits for the operator decision. */
  requestApproval(request: ApprovalRequest): Promise<ApprovalOutcome> {
    const rpcId = this.nextRpcId();
    const payload: ApprovalRequestedPayload = {
      type: "approval/requested",
      sessionId: request.sessionId,
      approvalId: request.approvalId,
      toolName: request.toolName,
      callId: request.callId,
      reason: request.reason,
    };
    return new Promise<ApprovalOutcome>((resolve) => {
      const timer = this.expiryTimer(rpcId, () => {
        resolve("expired");
        this.broadcastApprovalResolved(request.sessionId, request.approvalId, "expired");
      });
      this.pending.set(rpcId, {
        kind: "approval",
        rpcId,
        sessionId: request.sessionId,
        approvalId: request.approvalId,
        payload: { ...payload },
        resolve,
        timer,
      });
      this.broadcast(payload, rpcId);
    });
  }

  /** Mints + broadcasts a question card (the ask_user tool bridge) and waits for the answers. */
  requestQuestion(request: QuestionRequest): Promise<QuestionResolution> {
    const rpcId = this.nextRpcId();
    const payload = {
      type: "question/requested" as const,
      sessionId: request.sessionId,
      questions: request.questions,
    };
    return new Promise<QuestionResolution>((resolve) => {
      const timer = this.expiryTimer(rpcId, () => {
        resolve({ cancelled: true, outcome: "expired" });
        this.broadcastQuestionResolved(request.sessionId, rpcId, "expired");
      });
      this.pending.set(rpcId, {
        kind: "question",
        rpcId,
        sessionId: request.sessionId,
        payload: { ...payload, questions: [...request.questions] },
        resolve,
        timer,
      });
      this.broadcast(payload, rpcId);
    });
  }

  /** Handles one client-response; the receipt vocabulary is the frozen one. */
  respond(rpcId: string, result: RespondResult): RpcReceipt {
    const card = this.pending.get(rpcId);
    if (card === undefined) return { accepted: false, reason: "not-pending" };
    return card.kind === "approval"
      ? this.respondApproval(card, result)
      : this.respondQuestion(card, result);
  }

  /** The answerer/pending recovery payload (original frame bodies, verbatim). */
  pendingList(): PendingCardEntry[] {
    return [...this.pending.values()].map((card) => ({
      rpcId: card.rpcId,
      method: card.kind === "approval" ? ("approval/requested" as const) : ("question/requested" as const),
      payload: card.payload,
    }));
  }

  get size(): number {
    return this.pending.size;
  }

  // ---- internals ----

  private respondApproval(card: PendingApproval, result: RespondResult): RpcReceipt {
    if (result.ok) {
      const v = rec(result.value);
      if (v === null) return { accepted: false, reason: "bad-response" };
      if (v["sessionId"] !== card.sessionId || v["approvalId"] !== card.approvalId) {
        // rpcId matched but the named request does not — never resolve on a guess.
        return { accepted: false, reason: "not-pending" };
      }
      const outcome = v["outcome"];
      if (
        outcome !== "allowed-once" &&
        outcome !== "rejected" &&
        outcome !== "cancelled" &&
        outcome !== "unavailable"
      ) {
        return { accepted: false, reason: "bad-response" };
      }
      this.remove(card);
      card.resolve(outcome);
      this.broadcastApprovalResolved(card.sessionId, card.approvalId, outcome);
      return { accepted: true };
    }
    // A not-ok result is a decline only when it says "cancelled" (the frozen
    // decline wire form); anything else is a malformed response.
    if (result.error.code === "cancelled") {
      this.remove(card);
      card.resolve("rejected");
      this.broadcastApprovalResolved(card.sessionId, card.approvalId, "rejected");
      return { accepted: true };
    }
    return { accepted: false, reason: "bad-response" };
  }

  private respondQuestion(card: PendingQuestion, result: RespondResult): RpcReceipt {
    if (result.ok) {
      const v = rec(result.value);
      if (v === null || v["sessionId"] !== card.sessionId) return { accepted: false, reason: "not-pending" };
      const answer = rec(v["answer"]);
      const answers = answer?.["answers"];
      if (!Array.isArray(answers)) return { accepted: false, reason: "bad-response" };
      this.remove(card);
      card.resolve({ cancelled: false, answers: answers as QuestionAnswerItem[] });
      this.broadcastQuestionResolved(card.sessionId, card.rpcId, "answered");
      return { accepted: true };
    }
    if (result.error.code === "cancelled") {
      this.remove(card);
      card.resolve({ cancelled: true, outcome: "cancelled" });
      this.broadcastQuestionResolved(card.sessionId, card.rpcId, "cancelled");
      return { accepted: true };
    }
    return { accepted: false, reason: "bad-response" };
  }

  private remove(card: PendingCard): void {
    this.pending.delete(card.rpcId);
    clearTimeout(card.timer);
  }

  private nextRpcId(): string {
    return `fac-${Date.now()}-${++this.seq}`;
  }

  private expiryTimer(rpcId: string, onExpire: () => void): NodeJS.Timeout {
    const timer = setTimeout(() => {
      const card = this.pending.get(rpcId);
      if (card === undefined) return;
      this.pending.delete(rpcId);
      onExpire();
    }, this.ttlMs);
    // A dead hub must not wedge the timer handle.
    timer.unref?.();
    return timer;
  }

  private broadcastApprovalResolved(sessionId: string, approvalId: string, outcome: string): void {
    this.broadcast({ type: "approval/resolved", sessionId, approvalId, outcome }, "");
  }

  private broadcastQuestionResolved(sessionId: string, questionRpcId: string, outcome: string): void {
    this.broadcast({ type: "question/resolved", sessionId, questionRpcId, outcome }, "");
  }
}
