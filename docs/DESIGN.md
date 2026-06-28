# pi-pages — Locked Design

> Standalone agentic **static-artifact publisher**, built on pi. A caller summons pi-pages over
> pi's native RPC mode and converses with it in natural language; pi-pages owns the one Cloudflare
> Pages site + the publish know-how, copies the caller's artifact in, deploys, and returns a
> structured result with the live URL. Gated single-purpose sibling of `pi-deployment-manager`.
>
> Read alongside the shared philosophy in `../docs/building-pi-agents.md`.

## 1. Problem & goal

Frequently authored one-off static docs (`myr-thb-money-changer.html`, …) need a shareable URL, not
a file passed around. **Goal:** drop a static artifact and get back `https://<domain>/<slug>` in one
step — and make that handoff safe for *another* agent to drive, by gating pi-pages so it can only
ever publish static pages and can touch nothing else.

This is the lightweight twin of `pi-deployment-manager`: the manager deploys real apps (Coolify +
build pipeline); pi-pages serves **static files verbatim** on one Cloudflare Pages project. Things
needing a build (Astro/Vite/TSX) belong to the manager — pi-pages refuses non-static sources.

## 2. Topology — service, spawn-on-demand

Same shape as the manager: pi-pages is the **service**; the caller (a project agent, or the user via
the `publish-via-pages` skill) is the client. A publish is a task that runs to completion and returns
— no long-lived device. State of record is **Cloudflare Pages + the local artifacts folder**; cold
start loses nothing. The skill driver spawns pi-pages as a `pi --mode rpc` subprocess it owns
(`up` keeps one alive for back-and-forth; `publish` cold-starts and tears down on the result).

## 3. Interface — natural language, code-built result

No typed wire: the caller's request is a prompt; pi-pages's LLM interprets it and drives the verbs.
`publish` takes its target as params (`source`, optional `slug`, optional `overwrite`) — the LLM
extracts them from the prompt. A publish/unpublish concludes with a single `PublishResult` **built in
code** from the verb's outcome (never parsed from prose) and emitted on a `notify` event
(`PIPAGES_RESULT <json>`); a `PIPAGES_READY` notify on `session_start` lets the driver confirm boot.
Read-only verbs (`list`/`status`) return their answer as plain assistant text the driver relays.

**Conversational:** on a slug collision (or any block) pi-pages asks the caller and ends the turn; the
caller replies (`send`) and it continues. The DNS record for the domain is a one-time out-of-band
setup, so it is NOT part of the handoff.

## 4. Content model — one site, one folder, full redeploy

A Cloudflare Pages **deploy replaces the whole site** with the contents of the deployed directory. So
pi-pages owns a persistent **`artifacts_root`** that is the canonical set: each artifact is one entry
(`<slug>.html` for a file, `<slug>/` for a folder). `publish` copies the new artifact in and deploys
the *whole* root; Cloudflare content-addresses files, so unchanged artifacts are not re-uploaded.
`unpublish` removes the entry and redeploys. Losing `artifacts_root` loses the staging set (the last
deploy still serves), so it is a durable, configured location.

## 5. Execution layer — gated verbs, native engine in code

pi-pages's LLM has **no raw Bash/Read/Write/Edit/Glob** — it sees ONLY the four semantic verbs (§7),
pinned via `--no-builtin-tools` + `setActiveTools`. The engine is the verbs' own code:

```
pages LLM ──can only call──▶ [ publish | list | unpublish | status ]   ← the gate
                                   │  (tool implementation, in code)
                                   ├── native fetch → Cloudflare Pages API (ensure project + domain, status)
                                   └── subprocess → `wrangler pages deploy <artifacts_root>` (the only shell-out)
```

### 5.1 Sandbox (the gate) — `shared/sandbox.ts`, enforced in code

| capability | scope |
|------------|-------|
| **source** | a caller-named path, allowlisted to: a single `.html`/`.htm` file, OR a directory whose every file is a static web asset (html/css/js/img/font/…) and that has an `index.html`. Caps on file count/size. Anything else REFUSED before any read. |
| **write** | ONLY inside `artifacts_root` (slug vetted to a safe single path segment; escape refused). |
| **network** | Cloudflare API + the deploy upload (wrangler), via config creds. |
| **denied** | general Bash/Read/Write/Edit/Glob; any source that isn't allowlisted static web content. |

The source allowlist is why "it can only publish the html I gave it" is a code fact: a `.env`/`.ts`/
secret, or a folder carrying one, is rejected — not by an LLM rule, by a path/extension check.

## 6. Centralized creds

The Cloudflare **Pages: Edit** token + account id live in ONE place — pi-pages's `config.json`
(gitignored). They ride the wrangler subprocess ENV at deploy time; never argv, never committed. The
token needs nothing beyond Pages: Edit (project create + deploy + custom-domain attach are all Pages
API). DNS is a one-time record made out-of-band, so the token never needs DNS scope.

## 7. Verb surface — the complete tool set

| verb | r/w | does |
|------|-----|------|
| `publish` | write | validate source (allowlist) → derive/validate slug → collision guard → copy into `artifacts_root` → ensure Pages project + custom domain (idempotent) → `wrangler pages deploy` → health-probe the live artifact → conclude `PublishResult{url, preview_url, health}` |
| `list` | read | list staged artifacts (slug → URL) |
| `unpublish` | write | remove `<slug>` entry → redeploy → conclude result |
| `status` | read | Pages project + custom-domain + last deployment status |

`read ≠ write`: `list`/`status` never mutate and never conclude (their answer is the reply text).

## 8. Guards — fail-closed, in code

1. **Source-allowlist guard** (§5.1) — non-static or secret-bearing sources refused before read.
2. **Slug-collision guard** — `publish` to an existing slug without `overwrite` REFUSES (recoverable:
   the agent asks the caller to overwrite or rename). No silent clobber.
3. **Publish-health guard** — after deploy, probe the artifact on the live (`pages.dev`) site with
   retries; a result is `ok` ONLY if it actually serves. (The custom domain may lag a minute on first
   attach for its TLS cert, so health is checked on the immediately-live pages.dev alias, while the
   custom URL is reported as the shareable link.)

## 9. Flows

**Publish** — `publish(source[, slug][, overwrite])`: validate → slug → [collision? ask] → copy →
ensure project+domain → deploy → health → conclude `{url,…}`.
**Unpublish** — `unpublish(slug)`: [exists? else fail] → remove → deploy → conclude.

## 10. Config (`config.json`, single source of truth)

- `stateDir` — logs (`<stateDir>/logs/pages.log`) + the driver's session state.
- `cloudflare.{api_token, account_id}` — Pages: Edit token + account.
- `pages.{project_name, artifacts_root, domain, production_branch}` — the one site, its canonical
  folder, public domain, and production branch.
- `model` / `thinking` — optional session overrides.

`config.json.example` ships; live `config.json` is gitignored.

## 11. Deferred

- A deterministic structured door (typed publish spec, no LLM interpretation) for CI, once the NL flow
  is field-proven — mirrors the manager's deferred typed door.
- An upload-from-anywhere HTTP API (publish from a credential-less context, e.g. a phone). Only worth
  it if that case actually arises; the agent/skill path covers authoring-environment publishes.
- Per-deploy immutability / history beyond Cloudflare's own deployment list.
