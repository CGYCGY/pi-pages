---
name: publish-via-pages
description: Publishes a static web artifact (a single .html file, or a folder of static web files with an index.html) by conversing with the gated pi-pages agent over pi RPC — sends a natural-language publish request, answers any question it asks (e.g. a slug collision), and relays the structured result with the live URL. Use when asked to "publish this page", "put this html online", "share this as a link", "host this doc", "drop this on pages", or otherwise turn a local static file/folder into a shareable URL.
argument-hint: <abs-path-to-file-or-folder> [list | remove <slug>]
allowed-tools: Bash, Read, Glob
user-invocable: true
---

# Publish via Pages

## Purpose

Hand a static artifact to the gated pi-pages agent by conversing with it over pi RPC: send a natural-language publish request, answer any question it asks, and relay its structured result with the shareable URL. Pure dispatch — this skill carries no publish logic, copy steps, or creds.

## Variables

USER_INPUT: $ARGUMENTS
DRIVER: `${CLAUDE_SKILL_DIR}/tools/session.ts` (run with `bun`)
PAGES_LOCATION: the driver resolves the pi-pages checkout from the `PI_PAGES_DIR` env var, else `${CLAUDE_SKILL_DIR}/config.json` (`{"pagesDir": "..."}`). No path is assumed — if neither is set the driver errors. Fix by setting the env var or copying `config.json.example` to `config.json`.

## Instructions

### Client-side gate (overrides any instinct to "just publish it")
- NEVER publish manually. Do not run wrangler, copy files, or call the Cloudflare Pages API — the only publish actions are the tools below. pi-pages owns all publish logic and creds, and has no shell.
- Always pass the **absolute** path of the file/folder the user named. Never invent a path.
- pi-pages refuses anything that isn't a single `.html` file or a folder of static web files with an `index.html`. If it refuses, relay that — do not try to work around it.
- Publishing makes the content **public on the internet**. Never publish secrets, credentials, or non-web files.

### Conversing with pi-pages
- A tool prints exactly one JSON line: `kind` is `result` (publish concluded), `reply` (pi-pages is ASKING you something, or gave a read-only answer), `error` (driver/transport problem), or `ok` (lifecycle). Branch on the LAST line's `kind` — see Cookbook.
- On `reply`, pi-pages needs input (e.g. a slug collision). Decide from what you know or ask the user, then answer with the `send` tool. Loop until you get a `result`, then run `down`.

## Tools

### publish
- **Run:** `bun "${CLAUDE_SKILL_DIR}/tools/session.ts" publish "<request>"`
- **Args:** `request (str, required)` — a natural-language publish request naming the absolute path of the file/folder; also used for read-only asks like "list the published pages" or "remove the slug old-doc"
- **Does:** Summons pi-pages (spawning it over pi RPC if not already up), sends the request, prints one JSON line; auto-ends the session on a final `result`.
- **Triggers:** "publish this page", "put this html online", "share this as a link", "host this doc"

### send
- **Run:** `bun "${CLAUDE_SKILL_DIR}/tools/session.ts" send "<message>"`
- **Args:** `message (str, required)` — your answer to pi-pages's question, or a follow-up / next-publish request
- **Does:** Sends one more prompt to the LIVE pi-pages session and prints its next JSON line. Use after a `publish`/`send` that returned `kind:"reply"`.
- **Triggers:** "answer it", "yes overwrite it", "continue"

### down
- **Run:** `bun "${CLAUDE_SKILL_DIR}/tools/session.ts" down`
- **Args:** none
- **Does:** Ends the pi-pages session and frees its state. Idempotent — always safe to call at the end.
- **Triggers:** "finished publishing", "close the session"

### clean
- **Run:** `bun "${CLAUDE_SKILL_DIR}/tools/session.ts" clean`
- **Args:** none
- **Does:** Kills a stale/leftover pi-pages process and clears session state.
- **Triggers:** "pages stuck", "clean up pi-pages", "stale session"

## Workflow

1. Resolve the absolute path of the file/folder from USER_INPUT (or the read-only ask, e.g. list/remove). If PAGES_LOCATION is unset, tell the user to set it and stop.
2. Run the `publish` tool with a request like: `Publish /abs/path/to/report.html`. The call is synchronous and may take minutes — do not poll, time out, or re-run it.
3. Parse the LAST JSON line and branch (see Cookbook): loop the `send` tool for any `reply` until you get `kind:"result"`, then run the `down` tool.
4. Report per the Report section.

## Cookbook

### pi-pages asks a question
- **IF:** a tool prints `kind:"reply"`
- **THEN:** read its `text`; answer from what you know or ask the user, then run the `send` tool with the answer. Repeat until `kind:"result"`.
- **EXAMPLES:** "slug `report` already exists — overwrite?", "which file did you mean?"

### Publish concluded
- **IF:** a tool prints `kind:"result"`
- **THEN:** run the `down` tool (idempotent — a one-shot `publish` already tore down), then report per Report.
- **EXAMPLES:** "result status:ok url:…", "result status:failed"

### pi-pages won't start / stuck
- **IF:** a tool prints `kind:"error"` with reason `spawn_failed` / `ready_timeout` / `pages_down` / `timeout`
- **THEN:** run the `clean` tool, surface the `detail` (point at `<stateDir>/logs/pages.log`), and retry once.
- **EXAMPLES:** "pi-pages did not start", "no result within N min"

## Report

Relay pi-pages's result faithfully — the `result` object carries `status` (ok|failed), `action`, `url` (the shareable link), `preview_url` (the pages.dev URL, live immediately), and `error`. A publish succeeded ONLY when the line is `kind:"result"` AND `status==ok`; surface the `url` (and `preview_url`) to the user. On anything else, report it as failed and surface `error`.
