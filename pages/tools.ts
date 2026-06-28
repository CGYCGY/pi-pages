// The four verbs registered as pi tools — the COMPLETE tool surface the pi-pages LLM sees.
// Built-in tools are gated off (--no-builtin-tools + setActiveTools), so these are the only
// representable actions. read ≠ write: list/status never mutate. publish/unpublish are
// self-contained (each takes its full target as params and concludes with a code-built
// PublishResult) — there is no multi-turn bound context to carry.
//
// The verbs' CODE drives wrangler + the Cloudflare API; the LLM never reaches a shell. Every
// path the code touches is vetted by shared/sandbox (source allowlist + write confinement).

import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { getPages } from "../shared/config.ts";
import type { Logger } from "../shared/log.ts";
import {
  assertSafeSlug,
  destPathFor,
  findSlugCollisions,
  listArtifactSlugs,
  slugify,
  validateSource,
} from "../shared/sandbox.ts";
import type { PublishResult } from "../shared/types.ts";

import { type DeploymentInfo, ensureDomain, ensureProject, getProject, latestDeployment } from "./cloudflare.ts";
import { assertReachable } from "./guards.ts";
import { deployArtifacts } from "./wrangler.ts";

export interface PagesToolDeps {
  roleLog: Logger;
  /** Emit the code-built PublishResult to the caller — the terminal point of a publish/unpublish. */
  concludeTask: (ctx: ExtensionContext, result: PublishResult) => void;
  setActiveCtx: (ctx: ExtensionContext) => void;
}

/** The complete verb set. Passed to pi.setActiveTools as the gate's allowlist. */
export const VERB_NAMES = ["publish", "list", "unpublish", "status"] as const;

function ok(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

/** The URL path a file/dir artifact serves at (.html → clean slug; .htm kept; dir → slug). */
function publicPath(slug: string, kind: "file" | "dir", ext: string): string {
  if (kind === "dir") return slug;
  return ext === ".html" ? slug : `${slug}${ext}`;
}

export function registerPagesTools(pi: ExtensionAPI, deps: PagesToolDeps): void {
  const { roleLog, concludeTask, setActiveCtx } = deps;

  pi.registerTool({
    name: "publish",
    label: "Publish (write)",
    description:
      "Publish a static web artifact to the one Pages site, served at https://<domain>/<slug>. " +
      "source MUST be an absolute path to a single .html file OR a folder of only static web " +
      "files (with an index.html) — anything else is refused in code. Copies the artifact into " +
      "the site and deploys the whole site. On a slug collision it refuses unless overwrite=true.",
    promptSnippet: "Publish a caller-named .html file or static folder and return its live URL.",
    promptGuidelines: [
      "source must be the absolute path the caller named — never invent one.",
      "On a slug collision, STOP and ask the caller to overwrite or pick a new slug.",
    ],
    parameters: Type.Object({
      source: Type.String({
        description: "Absolute path to a single .html file OR a folder of static web files (must contain index.html).",
      }),
      slug: Type.Optional(
        Type.String({
          description: "URL path segment to publish at (https://<domain>/<slug>). Defaults to the source name, slugified.",
        }),
      ),
      overwrite: Type.Optional(
        Type.Boolean({ description: "Replace an existing artifact at the same slug. Default false (refuse on collision)." }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      setActiveCtx(ctx);
      const p = params as { source: string; slug?: string; overwrite?: boolean };
      const pages = getPages();

      // 1) Source allowlist — fail closed before reading anything (sandbox enforces .html /
      //    static-folder-with-index; a .env or .ts source is refused here, not by the LLM).
      const src = validateSource(p.source);

      // 2) Resolve + validate the slug.
      const slug = p.slug ? assertSafeSlug(p.slug.trim().toLowerCase()) : slugify(p.source);
      if (!slug) throw new Error(`could not derive a slug from "${p.source}" — pass an explicit slug.`);

      // 3) Collision guard (recoverable): refuse a silent clobber. The agent relays this and
      //    asks the caller; a follow-up publish with overwrite=true proceeds. Not a ledger
      //    error — it's a question, not a terminal failure.
      mkdirSync(pages.artifacts_root, { recursive: true });
      const collisions = findSlugCollisions(pages.artifacts_root, slug);
      if (collisions.length > 0 && !p.overwrite) {
        throw new Error(
          `slug "${slug}" already exists (${collisions.length} entry). ` +
            `Ask the caller whether to overwrite it (re-call publish with overwrite=true) or choose a different slug.`,
        );
      }

      // 4) Copy the artifact into the site (write confinement: dest is vetted inside the root).
      const dest = destPathFor(pages.artifacts_root, slug, src.kind, src.ext);
      if (p.overwrite) for (const c of collisions) rmSync(c, { recursive: true, force: true });
      if (src.kind === "file") copyFileSync(src.full, dest);
      else cpSync(src.full, dest, { recursive: true });

      // 5) Ensure the Pages project + custom domain exist (idempotent; native API).
      await ensureProject(pages.project_name, pages.production_branch);
      const domainState = await ensureDomain(pages.project_name, pages.domain);

      // 6) Deploy the whole artifacts folder (wrangler; the only subprocess).
      const path = publicPath(slug, src.kind, src.ext);
      const url = `https://${pages.domain}/${path}`;
      const previewUrl = `https://${pages.project_name}.pages.dev/${path}`;
      const deploy = await deployArtifacts(pages.artifacts_root);
      if (!deploy.ok) {
        const result: PublishResult = {
          status: "failed",
          action: "publish",
          slug,
          url,
          error: "wrangler deploy failed",
          detail: deploy.tail.slice(-1200),
        };
        concludeTask(ctx, result);
        return ok(`Publish FAILED: wrangler deploy error. Reported to caller.`, { failed: true });
      }

      // 7) Health guard — confirm the artifact actually serves on the live (pages.dev) site.
      //    The custom domain may lag a minute on first attach (cert), so probe pages.dev, the
      //    production alias that updates immediately, and still report the custom URL as the link.
      const health = await assertReachable(previewUrl);
      let deployId: string | undefined;
      try {
        deployId = (await latestDeployment(pages.project_name)).id;
      } catch {
        /* non-fatal */
      }

      const result: PublishResult = {
        status: health.healthy ? "ok" : "failed",
        action: "publish",
        slug,
        url,
        preview_url: previewUrl,
        health: health.healthy ? "healthy" : "unhealthy",
        deployment: deployId,
        detail: health.healthy
          ? `${src.kind === "dir" ? `${src.files} files` : "1 file"} live (${health.detail})` +
            (domainState.attached ? `; custom domain ${pages.domain} just attached — its TLS cert may take a minute.` : "")
          : `deployed but not reachable: ${health.detail}`,
        error: health.healthy ? undefined : "post-deploy health check failed",
      };
      concludeTask(ctx, result);
      roleLog.info("published", { slug, url, health: result.health });
      return ok(
        health.healthy
          ? `Published ${slug}: ${url} (live; verified on ${previewUrl}).`
          : `Published but UNHEALTHY: ${health.detail}.`,
        { slug, url, health: result.health },
      );
    },
  });

  pi.registerTool({
    name: "list",
    label: "List (read)",
    description: "List the artifacts currently published (their slugs and live URLs). Read-only.",
    promptSnippet: "List the published artifacts and their URLs (read-only).",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      setActiveCtx(ctx);
      const pages = getPages();
      const items = listArtifactSlugs(pages.artifacts_root);
      if (items.length === 0) return ok("No artifacts published yet.", { count: 0 });
      const lines = items.map((it) => `- ${it.slug} → https://${pages.domain}/${it.slug}${it.kind === "dir" ? " (folder)" : ""}`);
      return ok(`${items.length} artifact(s):\n${lines.join("\n")}`, { count: items.length, slugs: items.map((i) => i.slug) });
    },
  });

  pi.registerTool({
    name: "unpublish",
    label: "Unpublish (write)",
    description:
      "Remove a published artifact by slug and redeploy the site without it. Concludes with a " +
      "result. Refuses (in code) a slug that does not exist.",
    promptSnippet: "Remove an artifact by slug and redeploy.",
    parameters: Type.Object({
      slug: Type.String({ description: "The slug of the artifact to remove (as shown by list)." }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      setActiveCtx(ctx);
      const pages = getPages();
      const slug = assertSafeSlug((params as { slug: string }).slug.trim().toLowerCase());
      const collisions = findSlugCollisions(pages.artifacts_root, slug);
      if (collisions.length === 0) {
        const result: PublishResult = { status: "failed", action: "unpublish", slug, error: `no artifact "${slug}" to remove` };
        concludeTask(ctx, result);
        return ok(`No artifact "${slug}" exists. Reported to caller.`, { failed: true });
      }

      for (const c of collisions) rmSync(c, { recursive: true, force: true });
      const deploy = await deployArtifacts(pages.artifacts_root);
      const result: PublishResult = deploy.ok
        ? { status: "ok", action: "unpublish", slug, detail: `removed and redeployed (${listArtifactSlugs(pages.artifacts_root).length} artifact(s) remain).` }
        : { status: "failed", action: "unpublish", slug, error: "wrangler deploy failed", detail: deploy.tail.slice(-1200) };
      concludeTask(ctx, result);
      roleLog.info("unpublished", { slug, status: result.status });
      return ok(result.status === "ok" ? `Removed ${slug} and redeployed.` : `Unpublish FAILED: deploy error.`, {
        slug,
        status: result.status,
      });
    },
  });

  pi.registerTool({
    name: "status",
    label: "Status (read)",
    description: "Report the Pages project, its custom-domain attachment, and the latest deployment status. Read-only.",
    promptSnippet: "Report the Pages project + last deployment status (read-only).",
    parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, ctx) {
      setActiveCtx(ctx);
      const pages = getPages();
      const project = await getProject(pages.project_name);
      if (!project) return ok(`Project "${pages.project_name}" does not exist yet (publish something to create it).`, { exists: false });
      const dep = await latestDeployment(pages.project_name).catch((): DeploymentInfo => ({}));
      const count = listArtifactSlugs(pages.artifacts_root).length;
      return ok(
        `Project ${project.name} (${project.subdomain}); custom domain ${pages.domain}; ` +
          `${count} artifact(s) staged; last deployment ${dep.status ?? "n/a"}${dep.id ? ` (${dep.id})` : ""}.`,
        { project: project.name, last_status: dep.status, artifacts: count },
      );
    },
  });
}
