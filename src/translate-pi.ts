/**
 * Pi event stream / JSONL entries → frozen-contract wire events.
 *
 * Pure translation, no Pi imports: the input is the documented Pi event/entry
 * JSON (recorded live samples in test/fixtures/pi-events.json), the output is
 * the bare session-event shape of docs/contract-map.md §8. Two run-level rules
 * carry the DSH semantics (verified against dsh-agent-loop and the manager
 * runner, contract-map §4):
 *
 *  - one wire turn per RUN: turn/start opens on the first Pi turn_start,
 *    turn/end is emitted on agent_settled (Pi emits turn_end per LLM round;
 *    the manager ends the whole run on the first turn/end it sees);
 *  - usage rides the assistant message (renamed fields, cost dropped — the
 *    manager prices runs itself), system/user message frames never carry it.
 */

/** Wire usage block (contract-map §9): DSH field names, no cost. */
export interface WireUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface WireEvent {
  type: string;
  seq: number;
  data: Record<string, unknown>;
}

const rec = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const numOf = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Pi Usage → wire usage. Returns null when no token counts are present. */
export const renameUsage = (usage: unknown): WireUsage | null => {
  const source = rec(usage);
  if (source === null) return null;
  const inputTokens = numOf(source["input"]);
  const outputTokens = numOf(source["output"]);
  if (inputTokens === undefined && outputTokens === undefined) return null;
  const out: WireUsage = { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 };
  const cacheReadTokens = numOf(source["cacheRead"]);
  if (cacheReadTokens !== undefined) out.cacheReadTokens = cacheReadTokens;
  const cacheWriteTokens = numOf(source["cacheWrite"]);
  if (cacheWriteTokens !== undefined) out.cacheWriteTokens = cacheWriteTokens;
  const reasoningTokens = numOf(source["reasoning"]);
  if (reasoningTokens !== undefined) out.reasoningTokens = reasoningTokens;
  return out;
};

export interface WireTurnReason {
  kind: string;
  error?: { message: string; code: string };
  reason?: { kind: string };
}

/**
 * Pi stopReason → wire turn/end reason (contract-map §8). The manager reads
 * detail only for kind 'error' (error.message/code) and 'aborted'
 * (reason.kind); other kinds pass through as strings.
 */
export const stopReasonToTurnReason = (stopReason: unknown, errorMessage?: unknown): WireTurnReason => {
  switch (stopReason) {
    case "aborted":
      return { kind: "aborted", reason: { kind: "abort" } };
    case "error":
      return {
        kind: "error",
        error: { message: typeof errorMessage === "string" ? errorMessage : "provider error", code: "provider_error" },
      };
    case "length":
      return { kind: "max_tokens" };
    default:
      // stop / toolUse / deferred / pending / unknown: the run completed as far as the wire cares.
      return { kind: "completed" };
  }
};

/** Pi assistant content blocks → wire text/reasoning blocks (thinking → reasoning). */
export const contentBlocksToWire = (content: unknown): Array<{ type: "text" | "reasoning"; text: string }> => {
  if (!Array.isArray(content)) return [];
  const out: Array<{ type: "text" | "reasoning"; text: string }> = [];
  for (const block of content) {
    const b = rec(block);
    if (b === null) continue;
    if (b["type"] === "text" && typeof b["text"] === "string") out.push({ type: "text", text: b["text"] });
    else if (b["type"] === "thinking" && typeof b["thinking"] === "string") out.push({ type: "reasoning", text: b["thinking"] });
  }
  return out;
};

/** Best-effort text extraction from a Pi tool result payload. */
export const resultToText = (result: unknown): string => {
  if (typeof result === "string") return result;
  const source = rec(result);
  if (source !== null && Array.isArray(source["content"])) {
    return source["content"]
      .map((block) => {
        const b = rec(block);
        if (b === null) return "";
        if (b["type"] === "text" && typeof b["text"] === "string") return b["text"];
        if (b["type"] === "image") return "[image]";
        return "";
      })
      .join("");
  }
  if (result === undefined || result === null) return "";
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
};

const textOfContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  return contentBlocksToWire(content).map((block) => block.text).join("");
};

/**
 * Stateful live-event translator for one session. Feed every AgentSessionEvent
 * (as plain JSON) and collect wire payloads; the engine stamps sessionId.
 */
export class SessionTranslator {
  private seq = 0;
  private turn = 0;
  private turnOpen = false;
  private lastStop: { stopReason: unknown; errorMessage: unknown } = { stopReason: "stop", errorMessage: undefined };

  private nextSeq(): number {
    return ++this.seq;
  }

  /** Translates one Pi event into zero or more wire events. */
  onEvent(event: unknown): WireEvent[] {
    const source = rec(event);
    if (source === null) return [];
    const out: WireEvent[] = [];
    const push = (type: string, data: Record<string, unknown>): void => {
      out.push({ type, seq: this.nextSeq(), data });
    };

    switch (source["type"]) {
      case "turn_start":
        if (!this.turnOpen) {
          this.turnOpen = true;
          this.turn += 1;
          this.lastStop = { stopReason: "stop", errorMessage: undefined };
          push("turn/start", { turn: this.turn });
        }
        return out;

      case "message_update": {
        const deltaEvent = rec(source["assistantMessageEvent"]);
        if (deltaEvent === null) return out;
        switch (deltaEvent["type"]) {
          case "text_delta":
            if (typeof deltaEvent["delta"] === "string" && deltaEvent["delta"] !== "") {
              push("assistant/chunk", { chunk: { type: "text-delta", text: deltaEvent["delta"] } });
            }
            return out;
          case "thinking_delta":
            if (typeof deltaEvent["delta"] === "string" && deltaEvent["delta"] !== "") {
              push("assistant/chunk", { chunk: { type: "reasoning-delta", text: deltaEvent["delta"] } });
            }
            return out;
          case "toolcall_delta": {
            // The partial assistant message exposes the ToolCall block being streamed.
            const partial = rec(deltaEvent["partial"]);
            const content = partial?.["content"];
            const index = numOf(deltaEvent["contentIndex"]);
            const block = Array.isArray(content) && index !== undefined ? rec(content[index]) : null;
            if (block !== null && block["type"] === "toolCall") {
              push("assistant/chunk", {
                chunk: {
                  type: "tool-call-delta",
                  id: block["id"] ?? null,
                  name: block["name"] ?? null,
                  argumentsDelta: typeof deltaEvent["delta"] === "string" ? deltaEvent["delta"] : "",
                },
              });
            }
            return out;
          }
          default:
            // text_start/thinking_start/toolcall_start/*_end carry no wire deltas;
            // message_end is authoritative.
            return out;
        }
      }

      case "message_end": {
        const message = rec(source["message"]);
        if (message === null) return out;
        const role = message["role"];
        if (role === "system") return out; // never on the wire (P0 live evidence)
        if (role === "user") {
          push("user/message", {
            id: message["responseId"] ?? String(message["timestamp"] ?? this.seq),
            content: [{ type: "text", text: textOfContent(message["content"]) }],
          });
          return out;
        }
        if (role === "assistant") {
          this.lastStop = { stopReason: message["stopReason"], errorMessage: message["errorMessage"] };
          const data: Record<string, unknown> = {
            message: { content: contentBlocksToWire(message["content"]) },
          };
          const usage = renameUsage(message["usage"]);
          if (usage !== null) data["usage"] = usage;
          push("assistant/message", data);
          return out;
        }
        if (role === "toolResult") {
          // Live runs deliver tool results via tool_execution_end; the entry form
          // is for cold history. Accept both, dedupe by toolCallId.
          if (typeof message["toolCallId"] === "string" && this.seenToolResults.has(message["toolCallId"])) return out;
          if (typeof message["toolCallId"] === "string") this.seenToolResults.add(message["toolCallId"]);
          push("tool/result", toolResultData(message["content"], message["isError"] === true));
          return out;
        }
        return out;
      }

      case "tool_execution_start":
        push("tool/call", {
          name: typeof source["toolName"] === "string" ? source["toolName"] : "",
          arguments: safeStringify(source["args"]),
        });
        return out;

      case "tool_execution_end": {
        const toolCallId = typeof source["toolCallId"] === "string" ? source["toolCallId"] : "";
        if (toolCallId !== "") this.seenToolResults.add(toolCallId);
        push("tool/result", toolResultData(
          [{ type: "text", text: resultToText(source["result"]) }],
          source["isError"] === true,
        ));
        return out;
      }

      case "agent_settled":
        if (this.turnOpen) {
          this.turnOpen = false;
          push("turn/end", {
            turn: this.turn,
            reason: stopReasonToTurnReason(this.lastStop.stopReason, this.lastStop.errorMessage),
          });
        }
        return out;

      default:
        // agent_start/agent_end/message_start/queue_update/compaction_*/retry events
        // have no wire form (contract-map §8 closed mapping).
        return out;
    }
  }

  /** Closes an open turn with an error after a run rejection (silence backstop). */
  failTurn(message: string): WireEvent[] {
    const out: WireEvent[] = [];
    if (!this.turnOpen) {
      this.turnOpen = true;
      this.turn += 1;
      out.push({ type: "turn/start", seq: this.nextSeq(), data: { turn: this.turn } });
    }
    this.turnOpen = false;
    out.push({
      type: "turn/end",
      seq: this.nextSeq(),
      data: { turn: this.turn, reason: { kind: "error", error: { message, code: "prompt_failed" } } },
    });
    return out;
  }

  private readonly seenToolResults = new Set<string>();
}

const safeStringify = (value: unknown): string => {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
};

/** Wire data for tool/result: the manager reads message.content[0].content + isError. */
const toolResultData = (content: unknown, isError: boolean): Record<string, unknown> => ({
  message: {
    content: [
      {
        content: Array.isArray(content)
          ? content
              .map((block) => {
                const b = rec(block);
                if (b === null) return null;
                if (b["type"] === "text" && typeof b["text"] === "string") return { type: "text", text: b["text"] };
                if (b["type"] === "image") return { type: "text", text: "[image]" };
                return null;
              })
              .filter((block): block is { type: "text"; text: string } => block !== null)
          : [{ type: "text", text: resultToText(content) }],
        isError,
      },
    ],
  },
});

/**
 * Cold history: persisted JSONL entries (SessionManager.getEntries active branch)
 * → wire events. The JSONL tree does not persist turn or tool-execution
 * events, so both are synthesized: runs are grouped user-message → last
 * assistant before the next user message; tool/call events come from the
 * assistant messages' toolCall content blocks (the same data the live stream
 * delivered via tool_execution_start).
 */
export const historyEntriesToEvents = (entries: readonly unknown[]): WireEvent[] => {
  const out: WireEvent[] = [];
  let seq = 0;
  let turn = 0;
  let runOpen = false;
  let lastStop: unknown = "stop";
  let lastError: unknown;
  const push = (type: string, data: Record<string, unknown>): void => {
    out.push({ type, seq: ++seq, data });
  };
  const closeRun = (): void => {
    if (!runOpen) return;
    runOpen = false;
    push("turn/end", { turn, reason: stopReasonToTurnReason(lastStop, lastError) });
  };
  for (const raw of entries) {
    const entry = rec(raw);
    if (entry === null || entry["type"] !== "message") continue;
    const message = rec(entry["message"]);
    if (message === null) continue;
    switch (message["role"]) {
      case "user":
        closeRun();
        push("user/message", {
          id: typeof entry["id"] === "string" ? entry["id"] : String(message["timestamp"] ?? seq),
          content: [{ type: "text", text: textOfContent(message["content"]) }],
        });
        break;
      case "assistant": {
        if (!runOpen) {
          runOpen = true;
          turn += 1;
          lastStop = "stop";
          lastError = undefined;
          push("turn/start", { turn });
        }
        lastStop = message["stopReason"];
        lastError = message["errorMessage"];
        const data: Record<string, unknown> = { message: { content: contentBlocksToWire(message["content"]) } };
        const usage = renameUsage(message["usage"]);
        if (usage !== null) data["usage"] = usage;
        push("assistant/message", data);
        const content = message["content"];
        if (Array.isArray(content)) {
          for (const block of content) {
            const b = rec(block);
            if (b !== null && b["type"] === "toolCall") {
              push("tool/call", { name: String(b["name"] ?? ""), arguments: safeStringify(b["arguments"]) });
            }
          }
        }
        break;
      }
      case "toolResult":
        push("tool/result", toolResultData(message["content"], message["isError"] === true));
        break;
      default:
        break; // system messages never reach the wire
    }
  }
  closeRun();
  return out;
};

/** Extracts the last known model selection + title from persisted entries (projections). */
export const projectionsFromEntries = (
  entries: readonly unknown[],
): { title: string | null; model: { provider: string; model: string } | null } => {
  let title: string | null = null;
  let model: { provider: string; model: string } | null = null;
  for (const raw of entries) {
    const entry = rec(raw);
    if (entry === null) continue;
    if (entry["type"] === "session_info" && typeof entry["name"] === "string" && entry["name"] !== "") {
      title = entry["name"];
    }
    if (entry["type"] === "model_change" && typeof entry["provider"] === "string" && typeof entry["modelId"] === "string") {
      model = { provider: entry["provider"], model: entry["modelId"] };
    }
  }
  return { title, model };
};
