/**
 * shared/sandbox.ts — the gate, enforced in code (the building-pi-agents litmus: make the
 * wrong action UNREPRESENTABLE, not merely discouraged).
 *
 * pi-pages takes a caller-named source and copies it into a public site. Two code-enforced
 * guarantees live here, never trusted to the LLM:
 *
 *   1. SOURCE ALLOWLIST — a source may ONLY be a single .html/.htm file, or a directory
 *      whose every file is a static web asset (html/css/js/img/font/…) with an index.html
 *      at its root. Anything else (a .env, a .ts, a .sh, a stray secret in a folder) is
 *      REFUSED before a single byte is read. This is why "it can only publish the html I
 *      gave it" is a fact, not a hope.
 *   2. WRITE CONFINEMENT — pi-pages only ever writes inside artifacts_root. Every copy/
 *      delete target is vetted here; a slug that escapes the root is refused.
 *
 * Uses only node: built-ins, no pi runtime dependency.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";

/**
 * Extensions allowed inside a published artifact — the static web surface a browser fetches.
 * NOT here on purpose: source/build files (.ts, .tsx, .jsx, .scss), configs/secrets (.env,
 * .pem, .key), archives, executables, anything that has no business on a static host.
 */
const STATIC_WEB_EXT = new Set([
  ".html", ".htm", ".css", ".js", ".mjs", ".cjs", ".json", ".map",
  ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".bmp",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".txt", ".xml", ".webmanifest", ".pdf", ".wasm", ".mp4", ".webm", ".mp3", ".ogg",
  ".md", ".csv",
]);

/** Single-file sources must be one of these (a page, not an asset on its own). */
const SINGLE_FILE_EXT = new Set([".html", ".htm"]);

/** Belt-and-braces caps so a runaway folder can't be published. */
const MAX_FILES = 2000;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024; // 100 MB

export type SourceKind = "file" | "dir";

export interface ValidatedSource {
  /** Resolved absolute path to the source. */
  full: string;
  kind: SourceKind;
  /** For a file: its extension (".html"). For a dir: "". */
  ext: string;
  /** Total bytes (for reporting). */
  bytes: number;
  /** File count (1 for a single file). */
  files: number;
}

/** True if `child` is `parent` itself or lives strictly inside it (no `..` escape). */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Validate a caller-named source against the allowlist. Throws (fail closed) on anything
 * that is not a single .html/.htm file or a directory of only-static-web files with an
 * index.html. Returns the resolved source on success.
 */
export function validateSource(source: string): ValidatedSource {
  if (typeof source !== "string" || source.length === 0) {
    throw new Error("source is required (an absolute path to an .html file or a folder of static web files).");
  }
  if (!isAbsolute(source)) {
    throw new Error(`source must be an absolute path (got "${source}").`);
  }
  const full = resolve(source);
  let st;
  try {
    st = statSync(full);
  } catch {
    throw new Error(`source does not exist: ${full}`);
  }

  if (st.isFile()) {
    const ext = extname(full).toLowerCase();
    if (!SINGLE_FILE_EXT.has(ext)) {
      throw new Error(
        `refused: a single-file source must be .html or .htm (got "${ext || "no extension"}"). ` +
          `To publish other static assets, put them in a folder with an index.html and pass the folder.`,
      );
    }
    return { full, kind: "file", ext, bytes: st.size, files: 1 };
  }

  if (st.isDirectory()) {
    let files = 0;
    let bytes = 0;
    let hasIndex = false;
    const offenders: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(p);
          continue;
        }
        if (!entry.isFile()) {
          // Symlinks / sockets / devices: refuse — only plain static files belong here.
          offenders.push(`${relative(full, p)} (not a regular file)`);
          continue;
        }
        files += 1;
        if (files > MAX_FILES) throw new Error(`refused: folder has more than ${MAX_FILES} files.`);
        const ext = extname(entry.name).toLowerCase();
        const rel = relative(full, p);
        if (!STATIC_WEB_EXT.has(ext)) {
          offenders.push(`${rel} (${ext || "no extension"})`);
        }
        bytes += statSync(p).size;
        if (bytes > MAX_TOTAL_BYTES) throw new Error(`refused: folder exceeds ${MAX_TOTAL_BYTES / (1024 * 1024)} MB.`);
        if (rel.toLowerCase() === "index.html" || rel.toLowerCase() === "index.htm") hasIndex = true;
      }
    };
    walk(full);

    if (files === 0) throw new Error(`refused: folder "${full}" is empty.`);
    if (offenders.length > 0) {
      const shown = offenders.slice(0, 10).join(", ");
      const more = offenders.length > 10 ? ` (+${offenders.length - 10} more)` : "";
      throw new Error(
        `refused: folder contains non-static-web file(s): ${shown}${more}. ` +
          `Only static web assets (html/css/js/images/fonts/…) may be published.`,
      );
    }
    if (!hasIndex) {
      throw new Error(
        `refused: folder has no index.html at its root — a published page folder must have one ` +
          `so https://<domain>/<slug> resolves.`,
      );
    }
    return { full, kind: "dir", ext: "", bytes, files };
  }

  throw new Error(`refused: source "${full}" is neither a regular file nor a directory.`);
}

/**
 * Derive a default slug from a source path: the basename, extension stripped, lowercased,
 * non-[a-z0-9-] runs collapsed to '-', trimmed. e.g. "MYR-THB Money Changer.html" → "myr-thb-money-changer".
 */
export function slugify(source: string): string {
  const base = basename(source).replace(/\.[^.]+$/, "");
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug;
}

/**
 * Assert a slug is a safe single URL path segment: lowercase alnum + dashes, can't be '.'/'..',
 * no slashes (so it can never escape artifacts_root when used as a path component).
 */
export function assertSafeSlug(slug: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(
      `invalid slug "${slug}": use lowercase letters, digits, and dashes only ` +
        `(must start alphanumeric, no slashes or dots).`,
    );
  }
  if (slug.length > 100) throw new Error(`invalid slug "${slug}": too long (max 100 chars).`);
  return slug;
}

/**
 * Resolve the destination path for a slug inside artifacts_root, asserting it stays inside.
 * A file artifact lands at <root>/<slug><ext>; a dir artifact at <root>/<slug>/.
 */
export function destPathFor(artifactsRoot: string, slug: string, kind: SourceKind, ext: string): string {
  assertSafeSlug(slug);
  const root = resolve(artifactsRoot);
  const name = kind === "file" ? `${slug}${ext}` : slug;
  const full = resolve(root, name);
  if (!isInside(root, full) || full === root) {
    throw new Error(`refused: slug "${slug}" resolves outside the artifacts root.`);
  }
  return full;
}

/**
 * Find any existing artifact entries that collide with a slug (the dir <slug>/ or any file
 * <slug>.* at the artifacts root). Returns their absolute paths (empty = free).
 */
export function findSlugCollisions(artifactsRoot: string, slug: string): string[] {
  assertSafeSlug(slug);
  const root = resolve(artifactsRoot);
  if (!existsSync(root)) return [];
  const hits: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const stem = entry.name.replace(/\.[^.]+$/, "");
    if (entry.name === slug || stem === slug) hits.push(join(root, entry.name));
  }
  return hits;
}

/** List published slugs: top-level entries of artifacts_root, mapped to their slug. */
export function listArtifactSlugs(artifactsRoot: string): Array<{ slug: string; entry: string; kind: SourceKind }> {
  const root = resolve(artifactsRoot);
  if (!existsSync(root)) return [];
  const out: Array<{ slug: string; entry: string; kind: SourceKind }> = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const slug = entry.name.replace(/\.[^.]+$/, "");
    out.push({ slug, entry: entry.name, kind: entry.isDirectory() ? "dir" : "file" });
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}
