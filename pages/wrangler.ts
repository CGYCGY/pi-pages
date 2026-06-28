// The one real subprocess: `wrangler pages deploy`. Uploads the WHOLE artifacts folder as
// a production deployment (Cloudflare content-addresses files, so unchanged artifacts are
// not re-uploaded). The Cloudflare token + account id ride the ENV, never argv. The verb
// code calls this; the LLM never reaches wrangler.

import { mkdirSync } from "node:fs";

import { getCloudflare, getPages, getStateDir } from "../shared/config.ts";
import { runCommand } from "../shared/subprocess.ts";

const DEPLOY_TIMEOUT_MS = 5 * 60_000;

export interface DeployOutcome {
  ok: boolean;
  /** The <hash>.<project>.pages.dev URL wrangler prints (a per-deploy alias). */
  previewUrl?: string;
  /** Tail of combined output (for diagnosing a failure). */
  tail: string;
}

/**
 * Deploy the artifacts folder to the Pages project on its production branch. Returns the
 * outcome; never throws on a non-zero exit (the caller turns it into a PublishResult).
 */
export async function deployArtifacts(artifactsRoot: string): Promise<DeployOutcome> {
  const cf = getCloudflare();
  const pages = getPages();
  // Run wrangler from the state dir, NOT the artifacts root: wrangler drops a `.wrangler/`
  // cache dir in its cwd, and the artifacts root IS the deployed directory — caching there
  // would pollute (and upload) the published site. The deploy target rides as an absolute arg.
  const cwd = getStateDir();
  mkdirSync(cwd, { recursive: true });
  const r = await runCommand(
    "wrangler",
    [
      "pages",
      "deploy",
      artifactsRoot,
      `--project-name=${pages.project_name}`,
      `--branch=${pages.production_branch}`,
      "--commit-dirty=true",
    ],
    {
      cwd,
      env: {
        CLOUDFLARE_API_TOKEN: cf.api_token,
        CLOUDFLARE_ACCOUNT_ID: cf.account_id,
        // Keep wrangler non-interactive and quiet about telemetry prompts.
        WRANGLER_SEND_METRICS: "false",
        CI: "1",
      },
      timeoutMs: DEPLOY_TIMEOUT_MS,
    },
  );
  const combined = `${r.stdout}\n${r.stderr}`;
  const m = combined.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.pages\.dev/i);
  return {
    ok: r.code === 0,
    previewUrl: m?.[0],
    tail: combined.trim().slice(-2000),
  };
}
