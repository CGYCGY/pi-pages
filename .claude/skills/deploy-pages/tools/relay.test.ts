import { describe, expect, test } from "bun:test";

import { RESULT_MARK } from "./lib.ts";
import { createRelay, type RelayOut } from "./relay.ts";

function harness() {
  const sent: Record<string, unknown>[] = [];
  const outs: RelayOut[] = [];
  let ready = 0;
  const relay = createRelay({
    send: (c) => sent.push(c),
    finish: (o) => outs.push(o),
    onReady: () => ready++,
  });
  return { relay, sent, outs, ready: () => ready };
}

const started = (id: string) => ({ type: "response", command: "prompt", id, success: true, data: { disposition: "started" } });
const settled = (aborted?: boolean) => (aborted === undefined ? { type: "agent_settled" } : { type: "agent_settled", aborted });
const resultNote = (r: object) => ({ type: "extension_ui_request", method: "notify", message: `${RESULT_MARK} ${JSON.stringify(r)}` });
const verdict = (id: string, text: string) => ({ type: "response", command: "get_last_assistant_text", id: `verdict:${id}`, success: true, data: { text } });

describe("relay", () => {
  test("concluded publish relays the code-built result", () => {
    const h = harness();
    h.relay.request("r1", "publish /a.html");
    expect(h.sent).toEqual([{ type: "prompt", message: "publish /a.html", id: "r1" }]);
    h.relay.handle(started("r1"));
    h.relay.handle(resultNote({ status: "ok", action: "publish" }));
    h.relay.handle(settled(false));
    expect(h.sent.at(-1)).toEqual({ type: "get_last_assistant_text", id: "verdict:r1" });
    h.relay.handle(verdict("r1", " done "));
    expect(h.outs).toEqual([{ id: "r1", kind: "result", result: { status: "ok", action: "publish" }, text: "done" }]);
    expect(h.relay.currentId).toBeUndefined();
  });

  test("no result → reply; missing aborted counts as false", () => {
    const h = harness();
    h.relay.request("r1", "publish /a.html");
    h.relay.handle(started("r1"));
    h.relay.handle(settled());
    h.relay.handle(verdict("r1", "slug exists — overwrite?"));
    expect(h.outs).toEqual([{ id: "r1", kind: "reply", text: "slug exists — overwrite?" }]);
  });

  test("aborted settle without a result → aborted error, no text fetch", () => {
    const h = harness();
    h.relay.request("r1", "publish /a.html");
    h.relay.handle(started("r1"));
    h.relay.handle(settled(true));
    expect(h.sent).toHaveLength(1);
    expect(h.outs).toEqual([{ id: "r1", kind: "error", reason: "aborted", detail: expect.any(String) }]);
  });

  test("aborted settle after a result still relays the result", () => {
    const h = harness();
    h.relay.request("r1", "publish /a.html");
    h.relay.handle(started("r1"));
    h.relay.handle(resultNote({ status: "ok", action: "publish" }));
    h.relay.handle(settled(true));
    h.relay.handle(verdict("r1", ""));
    expect(h.outs[0]?.kind).toBe("result");
  });

  test("rejected prompt → immediate error carrying pi's message", () => {
    const h = harness();
    h.relay.request("r1", "publish /a.html");
    h.relay.handle({ type: "response", command: "prompt", id: "r1", success: false, error: "Agent is already processing." });
    expect(h.outs).toEqual([{ id: "r1", kind: "error", reason: "prompt_rejected", detail: "Agent is already processing." }]);
  });

  test("handled prompt → immediate reply", () => {
    const h = harness();
    h.relay.request("r1", "/x");
    h.relay.handle({ type: "response", command: "prompt", id: "r1", success: true, data: { disposition: "handled" } });
    expect(h.outs).toHaveLength(1);
    expect(h.outs[0]?.kind).toBe("reply");
  });

  test("a timed-out run's late settle is never credited to the next request", () => {
    const h = harness();
    h.relay.request("r1", "publish /a.html");
    h.relay.handle(started("r1"));
    expect(h.relay.fail("timeout", "budget")).toBe(true);
    h.relay.handle(settled(true)); // no current → dropped
    h.relay.request("r2", "publish /b.html");
    h.relay.handle(settled(true)); // r2 not yet acknowledged → old run's settle, dropped
    expect(h.outs).toHaveLength(1);
    h.relay.handle(started("r2"));
    h.relay.handle(settled(false));
    h.relay.handle(verdict("r2", "ok"));
    expect(h.outs.map((o) => [o.id, o.kind])).toEqual([
      ["r1", "error"],
      ["r2", "reply"],
    ]);
  });

  test("a request during compaction is held until compaction_end", () => {
    const h = harness();
    h.relay.handle({ type: "compaction_start", reason: "manual" });
    h.relay.request("r1", "publish /a.html");
    expect(h.sent).toHaveLength(0);
    h.relay.handle({ type: "compaction_end", reason: "manual" });
    expect(h.sent).toEqual([{ type: "prompt", message: "publish /a.html", id: "r1" }]);
  });

  test("READY notify and non-object records", () => {
    const h = harness();
    h.relay.handle({ type: "extension_ui_request", method: "notify", message: "PIPAGES_READY pi-pages up" });
    h.relay.handle(null);
    h.relay.handle(42);
    expect(h.ready()).toBe(1);
  });
});
