/**
 * Wire types and envelope builders for the frozen apiproxy contract.
 * Shapes mirror docs/contract-map.md §2 (sources: manager rpc.ts:72-147,
 * respond.ts:26-53). Business outcomes always travel inside HTTP 200;
 * the envelope discriminates on result.ok.
 */

export interface ClientRequestEnvelope {
  type: "client-request";
  rpcId?: string;
  method: string;
  payload?: Record<string, unknown>;
}

export interface ServerResponseOk {
  type: "server-response";
  rpcId?: string;
  result: { ok: true; value: unknown };
}

export interface ServerResponseError {
  type: "server-response";
  rpcId?: string;
  result: { ok: false; error: { code: string; message: string; details?: unknown } };
}

export type ServerResponseEnvelope = ServerResponseOk | ServerResponseError;

export const serverOk = (rpcId: string | undefined, value: unknown): ServerResponseOk => ({
  type: "server-response",
  ...(rpcId !== undefined ? { rpcId } : {}),
  result: { ok: true, value },
});

export const serverErr = (
  rpcId: string | undefined,
  code: string,
  message: string,
  details?: unknown,
): ServerResponseError => ({
  type: "server-response",
  ...(rpcId !== undefined ? { rpcId } : {}),
  result: { ok: false, error: { code, message, ...(details !== undefined ? { details } : {}) } },
});

/**
 * Parses an untrusted request body into a client-request envelope.
 * Returns null for anything malformed (carrier-level 400, never a guess).
 */
export const parseClientRequest = (body: unknown): ClientRequestEnvelope | null => {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const raw = body as Record<string, unknown>;
  if (raw["type"] !== "client-request") return null;
  if (typeof raw["method"] !== "string" || raw["method"] === "") return null;
  if (raw["rpcId"] !== undefined && typeof raw["rpcId"] !== "string") return null;
  const payload = raw["payload"];
  if (payload !== undefined && (payload === null || typeof payload !== "object" || Array.isArray(payload))) return null;
  return {
    type: "client-request",
    ...(typeof raw["rpcId"] === "string" ? { rpcId: raw["rpcId"] } : {}),
    method: raw["method"],
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  };
};

/** Extracts the concatenated text of a prompt content-block array (§3 session.prompt). */
export const textOfContentBlocks = (content: unknown): string | null => {
  if (!Array.isArray(content)) return null;
  let text = "";
  for (const block of content) {
    if (block === null || typeof block !== "object") return null;
    const b = block as Record<string, unknown>;
    if (b["type"] !== "text") continue;
    if (typeof b["text"] !== "string") return null;
    text += b["text"];
  }
  return text;
};
