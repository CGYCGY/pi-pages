// Shared helpers for the publish-via-pages RPC driver. The driver summons the gated pi-pages
// over pi's native --mode rpc (stdin/stdout JSONL, no HTTP/port) and converses with it. This
// file owns: locating pi-pages (config only, never a hardcoded path), loading its config, the
// pi spawn argv (THE GATE), JSONL framing, and the notify-marker contract pi-pages emits.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TOOLS_DIR = dirname(fileURLToPath(import.meta.url));
export const SKILL_DIR = resolve(TOOLS_DIR, "..");

// Notify markers pi-pages emits on the RPC event stream (extension_ui_request/method:"notify").
// READY = session booted; RESULT = a code-derived PublishResult JSON.
export const READY_MARK = "PIPAGES_READY";
export const RESULT_MARK = "PIPAGES_RESULT";

// pi process --name tag; distinctive enough that `pkill -f PI_NAME` targets pi-pages's pi
// without matching the driver's own argv.
export const PI_NAME = "pi-pages:rpc";

export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Resolve the pi-pages checkout — CONFIG ONLY, never a hardcoded fallback.
 * Order: PI_PAGES_DIR env var, then the skill-local config.json {pagesDir}.
 */
export function resolvePagesDir(): string {
  const fromEnv = process.env.PI_PAGES_DIR?.trim();
  let dir = fromEnv || readSkillConfig().pagesDir?.trim();
  if (!dir) {
    throw new Error(
      "pi-pages location not configured. Set PI_PAGES_DIR, or add " +
        `{"pagesDir": "/abs/path/to/pi-pages"} to ${join(SKILL_DIR, "config.json")} (see config.json.example).`,
    );
  }
  dir = expandTilde(dir);
  if (!existsSync(join(dir, "pages", "index.ts"))) {
    throw new Error(`pi-pages dir "${dir}" is not a pi-pages checkout (no pages/index.ts).`);
  }
  return dir;
}

interface SkillConfig {
  pagesDir?: string;
}

function readSkillConfig(): SkillConfig {
  const file = join(SKILL_DIR, "config.json");
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as SkillConfig;
  } catch {
    return {};
  }
}

export interface PagesCfg {
  stateDir: string;
  model?: string;
  thinking?: string;
}

/** Read pi-pages's own config.json for stateDir + model/thinking (creds stay untouched). */
export function loadPagesCfg(pagesDir: string): PagesCfg {
  const file = join(pagesDir, "config.json");
  let raw: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      throw new Error(`pi-pages config.json is not valid JSON: ${file}`);
    }
  }
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
  return {
    stateDir: expandTilde(str(raw.stateDir) ?? "~/.pi-pages"),
    model: str(raw.model),
    thinking: str(raw.thinking),
  };
}

export interface Paths {
  dir: string;
  fifo: string;
  out: string;
  state: string;
}

export function paths(stateDir: string): Paths {
  return {
    dir: stateDir,
    fifo: join(stateDir, "client.in"),
    out: join(stateDir, "client.out"),
    state: join(stateDir, "client.json"),
  };
}

/**
 * The pi argv that summons pi-pages in RPC mode. THE GATE: --no-builtin-tools makes
 * bash/read/write/edit/glob unrepresentable; --no-extensions blocks other extensions from
 * re-adding tools; -nc drops ambient AGENTS.md/CLAUDE.md. --mode rpc = stdin/stdout JSONL.
 */
export function piArgs(pagesDir: string, cfg: PagesCfg): string[] {
  const args = [
    "--no-extensions",
    "--no-builtin-tools",
    "-nc",
    "--mode",
    "rpc",
    "-e",
    join(pagesDir, "pages", "index.ts"),
    "--name",
    PI_NAME,
  ];
  if (cfg.model) args.push("--model", cfg.model);
  if (cfg.thinking) args.push("--thinking", cfg.thinking);
  return args;
}

/**
 * Inspect one parsed RPC event for pi-pages's notify markers. READY/RESULT are the two
 * structured signals; everything else (plain assistant text) is a human reply for the caller.
 */
export function parseNotify(msg: unknown): { ready?: boolean; result?: unknown } {
  const m = msg as { type?: string; method?: string; message?: unknown };
  if (m?.type !== "extension_ui_request" || m?.method !== "notify") return {};
  const text = String(m.message ?? "");
  if (text.startsWith(READY_MARK)) return { ready: true };
  if (text.startsWith(RESULT_MARK)) {
    const json = text.slice(RESULT_MARK.length).trim();
    try {
      return { result: JSON.parse(json) };
    } catch {
      return { result: { status: "failed", action: "publish", error: `unparseable result: ${json.slice(0, 200)}` } };
    }
  }
  return {};
}

/** Split a growing buffer into complete LF-delimited lines (strip a stray \r). */
export function takeLines(buf: string): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let rest = buf;
  for (;;) {
    const nl = rest.indexOf("\n");
    if (nl < 0) break;
    let line = rest.slice(0, nl);
    rest = rest.slice(nl + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line) lines.push(line);
  }
  return { lines, rest };
}
