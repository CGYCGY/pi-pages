// Turns pi's RPC event stream into exactly one terminal line per caller request. Pure state
// machine (no pipes, no timers) so the settle/abort/response edge cases are testable.

import { parseNotify } from "./lib.ts";

export type RelayOut =
  | { id: string; kind: "result"; result: Record<string, unknown>; text: string }
  | { id: string; kind: "reply"; text: string }
  | { id: string; kind: "error"; reason: string; detail: string };

export interface RelayIO {
  send(cmd: Record<string, unknown>): void;
  /** Called once per request with its terminal outcome. */
  finish(out: RelayOut): void;
  onReady(): void;
}

interface RpcMsg {
  type?: string;
  id?: string;
  command?: string;
  success?: boolean;
  error?: string;
  aborted?: boolean;
  data?: { text?: string; disposition?: string };
}

export function createRelay(io: RelayIO) {
  // started: pi acknowledged THIS request's prompt. Only a settle after that belongs to it; an
  // earlier settle is a previous (e.g. timed-out, aborted) run finishing late.
  let current: { id: string; started: boolean; result?: Record<string, unknown> } | null = null;
  // pi rejects a prompt while compacting, and pi-pages compacts right after a concluded publish,
  // so a quick follow-up request is held until compaction_end.
  let compacting = false;
  let held: { id: string; message: string } | null = null;

  const finish = (out: RelayOut): void => {
    current = null;
    held = null;
    io.finish(out);
  };

  return {
    get currentId(): string | undefined {
      return current?.id;
    },

    request(id: string, message: string): void {
      current = { id, started: false };
      if (compacting) held = { id, message };
      else io.send({ type: "prompt", message, id });
    },

    /** End the current request with an error (timeout, pi exit). Returns whether one was pending. */
    fail(reason: string, detail: string): boolean {
      if (!current) return false;
      finish({ id: current.id, kind: "error", reason, detail });
      return true;
    },

    handle(raw: unknown): void {
      const msg = (raw && typeof raw === "object" ? raw : {}) as RpcMsg;
      const note = parseNotify(msg);
      if (note.ready) return io.onReady();
      if (note.result !== undefined) {
        if (current) current.result = note.result as Record<string, unknown>;
        return;
      }
      if (msg.type === "compaction_start") {
        compacting = true;
        return;
      }
      if (msg.type === "compaction_end") {
        compacting = false;
        if (held) {
          const h = held;
          held = null;
          io.send({ type: "prompt", message: h.message, id: h.id });
        }
        return;
      }
      if (!current) return;

      if (msg.type === "response" && msg.command === "prompt" && msg.id === current.id) {
        if (msg.success === false) {
          finish({ id: current.id, kind: "error", reason: "prompt_rejected", detail: msg.error ?? "pi rejected the prompt." });
        } else if (msg.data?.disposition === "handled") {
          // No run starts for a handled prompt, so no agent_settled will ever come.
          finish({ id: current.id, kind: "reply", text: "pi-pages handled the message without starting a turn; nothing was published." });
        } else {
          current.started = true;
        }
        return;
      }

      // Settle, not end: pi may follow an agent_end with an auto-retry, a compaction retry, or a
      // queued continuation, and answering there would relay the pre-retry text while pi is
      // still working — the next `send` would then hit a busy session.
      if (msg.type === "agent_settled") {
        if (!current.started) return;
        if (msg.aborted === true && current.result === undefined) {
          finish({ id: current.id, kind: "error", reason: "aborted", detail: "pi-pages's turn was aborted before it concluded." });
          return;
        }
        io.send({ type: "get_last_assistant_text", id: `verdict:${current.id}` });
        return;
      }

      if (msg.type === "response" && msg.id === `verdict:${current.id}`) {
        const text = (msg.data?.text ?? "").trim();
        // CONCLUDED iff pi-pages emitted its code-derived result this turn; else the assistant
        // text is a question/status to relay back to the caller.
        if (current.result !== undefined) finish({ id: current.id, kind: "result", result: current.result, text });
        else finish({ id: current.id, kind: "reply", text });
      }
    },
  };
}
