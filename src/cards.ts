/**
 * CardTable — the pending question/approval registry behind respond and
 * answerer/pending (contract-map §10/§11).
 *
 * A card is minted with a facade rpcId, broadcast once on the mux (with that
 * rpcId in the envelope), and waits for the manager's respond. Matching is
 * strict: rpcId finds the card, then sessionId + approvalId must name exactly
 * that request — anything else is "not-pending" (never a guess). Cards expire
 * after a TTL so a wedged operator UI cannot pin a tool call forever; the
 * manager's own backstop is 15 minutes, so the facade TTL matches it.
 */
import type { ApprovalOutcome, ApprovalRequest, ApprovalRequestedPayload, MuxPayload } from "./engine.ts";

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
  method: "approval/requested";
  payload: Record<string, unknown>;
}

interface PendingApproval {
  rpcId: string;
  sessionId: string;
  approvalId: string;
  payload: Record<string, unknown>;
  resolve: (outcome: ApprovalOutcome) => void;
  timer: NodeJS.Timeout;
}

export const CARD_TTL_MS = 15 * 60_000;

export class CardTable {
  private readonly pending = new Map<string, PendingApproval>();
  private readonly broadcast: (payload: MuxPayload, rpcId: string) => void;
  private readonly ttlMs: number;
  private seq = 0;

  constructor(broadcast: (payload: MuxPayload, rpcId: string) => void, ttlMs: number = CARD_TTL_MS) {
    this.broadcast = broadcast;
    this.ttlMs = ttlMs;
  }

  /** Mints + broadcasts an approval card and waits for the operator decision. */
  requestApproval(request: ApprovalRequest): Promise<ApprovalOutcome> {
    const rpcId = `fac-${Date.now()}-${++this.seq}`;
    const payload: ApprovalRequestedPayload = {
      type: "approval/requested",
      sessionId: request.sessionId,
      approvalId: request.approvalId,
      toolName: request.toolName,
      callId: request.callId,
      reason: request.reason,
    };
    return new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(rpcId)) {
          resolve("expired");
          this.broadcastResolved(request.sessionId, request.approvalId, "expired");
        }
      }, this.ttlMs);
      // A dead hub must not wedge the timer handle.
      timer.unref?.();
      this.pending.set(rpcId, { rpcId, sessionId: request.sessionId, approvalId: request.approvalId, payload: { ...payload }, resolve, timer });
      this.broadcast(payload, rpcId);
    });
  }

  /** Handles one client-response; the receipt vocabulary is the frozen one. */
  respond(rpcId: string, result: RespondResult): RpcReceipt {
    const card = this.pending.get(rpcId);
    if (card === undefined) return { accepted: false, reason: "not-pending" };

    if (result.ok) {
      const value = result.value;
      if (value === null || typeof value !== "object") return { accepted: false, reason: "bad-response" };
      const v = value as Record<string, unknown>;
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
      this.settle(rpcId, outcome);
      return { accepted: true };
    }

    // A not-ok result is a decline only when it says "cancelled" (the frozen
    // question-decline wire form); anything else is a malformed response.
    if (result.error.code === "cancelled") {
      this.settle(rpcId, "rejected");
      return { accepted: true };
    }
    return { accepted: false, reason: "bad-response" };
  }

  /** The answerer/pending recovery payload (original frame bodies, verbatim). */
  pendingList(): PendingCardEntry[] {
    return [...this.pending.values()].map((card) => ({
      rpcId: card.rpcId,
      method: "approval/requested" as const,
      payload: card.payload,
    }));
  }

  get size(): number {
    return this.pending.size;
  }

  private settle(rpcId: string, outcome: ApprovalOutcome): void {
    const card = this.pending.get(rpcId);
    if (card === undefined) return;
    this.pending.delete(rpcId);
    clearTimeout(card.timer);
    card.resolve(outcome);
    this.broadcastResolved(card.sessionId, card.approvalId, outcome);
  }

  private broadcastResolved(sessionId: string, approvalId: string, outcome: ApprovalOutcome): void {
    this.broadcast({ type: "approval/resolved", sessionId, approvalId, outcome }, "");
  }
}
