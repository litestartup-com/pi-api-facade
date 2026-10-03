/**
 * MuxHub — the full-volume broadcast fan-out for events.mux.
 *
 * One hub per facade process. The engine tap pushes every session's frames in
 * (the manager filters by sessionId client-side); the CardTable pushes card
 * frames with their respond rpcId. Sockets come and go (the manager reconnects
 * with backoff, contract-map §4) — the hub holds no per-socket state beyond
 * membership, and never replays: recovery is answerer/pending + history.
 */
import type { MuxPayload } from "./engine.ts";

/** Structural socket type (ws server sockets and test doubles both satisfy it). */
export interface MuxSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message" | "close" | "error", listener: (...args: never[]) => void): unknown;
}

const OPEN = 1;

export class MuxHub {
  private readonly sockets = new Set<MuxSocket>();

  add(socket: MuxSocket): void {
    this.sockets.add(socket);
  }

  remove(socket: MuxSocket): void {
    this.sockets.delete(socket);
  }

  get size(): number {
    return this.sockets.size;
  }

  /** Wraps a payload in the server-request envelope (method = payload.type). */
  broadcast(payload: MuxPayload, rpcId: string): void {
    if (this.sockets.size === 0) return;
    const envelope = JSON.stringify({ type: "server-request", rpcId, method: payload.type, payload });
    for (const socket of this.sockets) {
      if (socket.readyState !== OPEN) continue;
      try {
        socket.send(envelope);
      } catch {
        // A dead socket is dropped by its close handler; never kill the broadcast.
        this.sockets.delete(socket);
      }
    }
  }

  /** Taps an engine's global frame stream into the hub. Returns the untap function. */
  tapEngine(subscribeAll: (listener: (payload: MuxPayload) => void) => () => void): () => void {
    return subscribeAll((payload) => this.broadcast(payload, ""));
  }
}
