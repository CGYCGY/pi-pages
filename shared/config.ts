/**
 * shared/config.ts — load, parse, and expand config.json (pi-pages's single
 * source of truth: the Cloudflare Pages cred + the one site every artifact lands in).
 *
 * Read once (cached) at startup. The Cloudflare token is the only secret here; it is
 * injected into the wrangler subprocess env at deploy time and never written to disk.
 *
 * Uses only node: built-ins, no pi runtime dependency.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Directory containing this module (shared/), resolved at runtime. */
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Absolute project root, derived from this module's own location (shared/ lives directly
 * under it). Self-locating: survives moving/renaming the project dir, so it can never
 * drift the way a hardcoded path would.
 */
export const PROJECT_DIR = resolve(HERE, "..");

/** Absolute path to config.json (project root, parent of shared/). */
export const CONFIG_PATH = resolve(PROJECT_DIR, "config.json");

/** Cloudflare Pages creds — a token scoped to Account → Cloudflare Pages: Edit + its account id. */
export interface CloudflareConfig {
  api_token: string;
  account_id: string;
}

/** The one Pages site every artifact deploys into. */
export interface PagesConfig {
  /** Cloudflare Pages project name; also the <name>.pages.dev backend host. */
  project_name: string;
  /** Local folder that is the canonical content set — each artifact is one entry in it. */
  artifacts_root: string;
  /** Public domain the site is served at (https://<domain>/<slug>). */
  domain: string;
  /** The project's production branch; a deploy on this branch is the live one. */
  production_branch: string;
}

export interface Config {
  /** Self-located project root (not from JSON). */
  projectDir: string;
  /** State/logs dir (~ expanded). */
  stateDir: string;
  cloudflare: CloudflareConfig;
  pages: PagesConfig;
  /** Optional model + thinking overrides for the pi-pages session. */
  model?: string;
  thinking?: string;
}

/** Expand a leading "~" or "~/" to the user's home directory. */
export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** Validate the required shape; tolerate extra `_*` note keys (they're harmless). */
function parseConfig(raw: unknown): Config {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`config.json: expected an object, got ${typeof raw}`);
  }
  const r = raw as Record<string, unknown>;

  const obj = (key: string): Record<string, unknown> => {
    const v = r[key];
    if (typeof v !== "object" || v === null) {
      throw new Error(`config.json: "${key}" must be an object`);
    }
    return v as Record<string, unknown>;
  };
  const reqStr = (o: Record<string, unknown>, path: string, key: string): string => {
    const v = o[key];
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`config.json: "${path}.${key}" must be a non-empty string`);
    }
    return v;
  };
  const optStr = (o: Record<string, unknown>, key: string): string | undefined =>
    typeof o[key] === "string" && (o[key] as string).length > 0 ? (o[key] as string) : undefined;

  const cloudflare = obj("cloudflare");
  const pages = obj("pages");

  return {
    projectDir: PROJECT_DIR,
    stateDir: expandTilde(String(r.stateDir ?? "~/.pi-pages")),
    cloudflare: {
      api_token: reqStr(cloudflare, "cloudflare", "api_token"),
      account_id: reqStr(cloudflare, "cloudflare", "account_id"),
    },
    pages: {
      project_name: reqStr(pages, "pages", "project_name"),
      artifacts_root: expandTilde(optStr(pages, "artifacts_root") ?? "~/.pi-pages/artifacts"),
      domain: reqStr(pages, "pages", "domain"),
      production_branch: optStr(pages, "production_branch") ?? "main",
    },
    model: optStr(r, "model"),
    thinking: optStr(r, "thinking"),
  };
}

/** Cached parsed config (config.json does not change during a run). */
let cached: Config | null = null;

/** Load (and cache) the parsed, tilde-expanded config. */
export function loadConfig(): Config {
  if (cached) return cached;
  let text: string;
  try {
    text = readFileSync(CONFIG_PATH, "utf8");
  } catch (err) {
    throw new Error(`config.json not found at ${CONFIG_PATH}: ${(err as Error).message}`);
  }
  cached = parseConfig(JSON.parse(text));
  return cached;
}

/** Force a re-read on next access (useful in tests / after edits). */
export function clearConfigCache(): void {
  cached = null;
}

/** Project directory (absolute, self-located — see PROJECT_DIR). */
export function getProjectDir(): string {
  return PROJECT_DIR;
}

/** State/logs directory (~ expanded). */
export function getStateDir(): string {
  return loadConfig().stateDir;
}

export function getCloudflare(): CloudflareConfig {
  return loadConfig().cloudflare;
}
export function getPages(): PagesConfig {
  return loadConfig().pages;
}
export function getModelConfig(): { model?: string; thinking?: string } {
  const c = loadConfig();
  return { model: c.model, thinking: c.thinking };
}
