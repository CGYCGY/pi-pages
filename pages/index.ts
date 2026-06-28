// pi-pages: one gated pi session a caller SUMMONS over pi RPC mode and converses with in
// natural language. The caller names a static artifact to publish (or asks to list/remove
// one); the LLM drives the four verbs and a publish CONCLUDES by health-checking the live
// artifact. The structured PublishResult is emitted IN CODE (never parsed from prose) on a
// notify event the driver captures.
//
// THE GATE has two layers: the driver spawns pi with --no-builtin-tools (bash/read/write/
// edit/glob unrepresentable), and session_start pins the active set to exactly the four
// verbs. The verbs' own sandbox bounds what their CODE may touch (source allowlist + writes
// confined to artifacts_root). One purpose, one agent.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { getModelConfig } from "../shared/config.ts";
import { createLogger } from "../shared/log.ts";
import type { PublishResult, Role } from "../shared/types.ts";

import { registerPagesTools, VERB_NAMES } from "./tools.ts";

const ROLE: Role = "pages";

// Notify markers the driver greps for on the RPC event stream. READY confirms the session
// booted; RESULT carries the code-derived PublishResult JSON. Plain assistant text is a
// question/summary for the caller.
const READY_MARK = "PIPAGES_READY";
const RESULT_MARK = "PIPAGES_RESULT";

// pi-pages's persona, layered onto pi's base prompt. Flow-level only — no per-artifact
// premises that could be wrong (a hardcoded-wrong hint is worse than none).
const PAGES_RULES = `

## pi-pages
You are pi-pages — a single-purpose, gated service that publishes static web artifacts to ONE Cloudflare Pages site, served at https://<domain>/<slug>. A caller talks to you over RPC: each message names a file/folder to publish, or asks to list/remove one. Built-in tools (bash, read, write, edit, glob) are DISABLED — your ONLY tools are these four verbs, by design:

- publish (write) — START HERE for a publish request. Params: source (ABSOLUTE path to a single .html file OR a folder of static web files that has an index.html), optional slug (the URL path; defaults to the source name slugified), optional overwrite (default false). It copies the artifact into the site and deploys it; the public URL is https://<domain>/<slug>.
- list (read) — list the artifacts currently published (slugs + URLs).
- unpublish (write) — remove a published artifact by slug and redeploy.
- status (read) — the Pages project + last deployment status.

Working with the caller:
- Extract the source path (and slug/overwrite if the caller gave them) from the message and call publish. NEVER invent a path the caller did not name.
- Only static web content can be published: a single .html file, or a folder of html/css/js/images/fonts with an index.html. If publish refuses a source (not .html, a folder with non-web files, no index.html), relay that plainly — do not try to work around it.
- If publish reports a SLUG COLLISION (the slug exists and overwrite was not set), STOP and ASK the caller whether to overwrite (re-call publish with overwrite=true) or pick a new slug. End that turn with just the question; the caller replies and you continue. Never clobber silently.
- read != write: list/status never change anything — use them freely.
- A publish/unpublish CONCLUDES when the verb runs; its structured result is reported to the caller automatically IN CODE — do NOT write, format, or invent the result yourself. Your final message each turn is a short human summary, or a question.`;

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export default function pagesExtension(pi: ExtensionAPI) {
  const log = createLogger(ROLE);
  const modelCfg = getModelConfig();

  // Extension memory, NOT LLM context.
  let activeCtx: ExtensionContext | undefined;
  let cumulativeCost = 0;
  // Set by concludeTask so agent_end knows a task finished and can shed context.
  let concludedThisTurn = false;

  const refreshUI = (ctx?: ExtensionContext): void => {
    const c = ctx ?? activeCtx;
    if (!c?.hasUI) return;
    const usage = c.getContextUsage();
    const model = c.model?.id ?? "no-model";
    const ctxStr = usage?.tokens != null ? ` | ctx ${fmtTokens(usage.tokens)}` : "";
    c.ui.setStatus("pages", `● pi-pages | ${model}${ctxStr} | $${cumulativeCost.toFixed(3)}`);
  };

  /**
   * Conclude a publish/unpublish: emit its code-derived PublishResult on the RESULT notify
   * channel for the driver to capture. The verbs call this — the only terminal points.
   */
  const concludeTask = (ctx: ExtensionContext, result: PublishResult): void => {
    concludedThisTurn = true;
    try {
      ctx.ui.notify(`${RESULT_MARK} ${JSON.stringify(result)}`, result.status === "ok" ? "info" : "error");
    } catch (err) {
      log.warn("result notify failed", { err: String(err) });
    }
    log.info("task concluded", { action: result.action, status: result.status });
    refreshUI(ctx);
  };

  pi.on("session_start", async (_event, ctx) => {
    activeCtx = ctx;
    if (ctx.hasUI) ctx.ui.setWorkingIndicator(undefined);
    // Belt-and-braces with --no-builtin-tools: pin the active set to exactly the verbs.
    pi.setActiveTools([...VERB_NAMES]);
    refreshUI(ctx);
    try {
      ctx.ui.notify(`${READY_MARK} pi-pages up`, "info");
    } catch (err) {
      log.warn("ready notify failed", { err: String(err) });
    }
    log.info("pi-pages extension loaded", { model: modelCfg.model });
  });

  pi.on("before_agent_start", (event) => ({
    systemPrompt: event.systemPrompt + PAGES_RULES,
  }));

  pi.on("turn_start", async (_event, ctx) => {
    activeCtx = ctx;
  });
  pi.on("message_end", async (event, ctx) => {
    activeCtx = ctx;
    if (event.message.role === "assistant") {
      const usage = (event.message as { usage?: { cost?: { total?: number } } }).usage;
      if (usage?.cost?.total != null) cumulativeCost += usage.cost.total;
    }
    refreshUI(ctx);
  });
  pi.on("model_select", async (_event, ctx) => {
    activeCtx = ctx;
    refreshUI(ctx);
  });

  // After a concluded task, shed context so the next, unrelated publish starts clean. If the
  // turn did NOT conclude (the agent asked a question, e.g. a slug collision), leave context
  // in place so the caller's reply continues it.
  pi.on("agent_end", async (_event, ctx) => {
    activeCtx = ctx;
    if (!concludedThisTurn) return;
    concludedThisTurn = false;
    try {
      const usage = ctx.getContextUsage();
      if (usage?.tokens != null && usage.tokens > 2000) {
        ctx.compact({
          customInstructions:
            "A brand-new, UNRELATED publish may start next. Discard everything about the previous " +
            "artifact — its source, slug, and result are over and must NOT influence the next one. " +
            "Summarize to a single line: 'ready for next publish'.",
          onError: (e) => log.warn("compaction failed", { err: e.message }),
        });
      }
    } catch (err) {
      log.warn("compact failed", { err: String(err) });
    }
    refreshUI(ctx);
  });

  registerPagesTools(pi, {
    roleLog: log,
    concludeTask,
    setActiveCtx: (ctx) => {
      activeCtx = ctx;
    },
  });
}
