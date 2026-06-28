/**
 * shared/types.ts — pi-pages's result contract.
 *
 * pi-pages is summoned over pi RPC and conversed with in natural language: the caller's
 * request is a prompt, and each verb takes its target as params. A publish/unpublish
 * concludes with a single structured PublishResult, BUILT IN CODE (never parsed from the
 * LLM's prose) and emitted to the driver on the RESULT notify channel.
 *
 * Uses no pi runtime — importable from config/sandbox/log via jiti.
 */

/** pi-pages has a single session role (no spokes — a publish runs to completion). */
export type Role = "pages";

/**
 * The single structured result a publish/unpublish concludes with. BUILT FROM the verb's
 * own outcome in code. Read-only verbs (list/status) do NOT emit a result — their answer
 * is the assistant's reply text the driver relays verbatim.
 */
export interface PublishResult {
  status: "ok" | "failed";
  action: "publish" | "unpublish";
  /** The URL path slug the artifact lives at. */
  slug?: string;
  /** Public custom-domain URL (https://<domain>/<slug>) — the shareable link. */
  url?: string;
  /** The <project>.pages.dev URL — live immediately, before custom-domain cert settles. */
  preview_url?: string;
  /** Post-deploy reachability of the artifact on the live site. */
  health?: "healthy" | "unhealthy";
  /** wrangler deployment id, when captured. */
  deployment?: string;
  /** Human-readable detail (health probe result, what was removed, …). */
  detail?: string;
  /** Set on failure; presence forces status="failed". */
  error?: string;
}
