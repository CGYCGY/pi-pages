# pi-pages

Standalone agentic **static-artifact publisher**, built on [pi](https://github.com/earendil-works/pi). A caller hands off a static artifact — a single `.html` file, or a folder of static web files — over pi's native RPC mode, and pi-pages copies it into one Cloudflare Pages site and returns the live URL.

Gated single-purpose sibling of `pi-deployment-manager`: where the manager deploys real apps (Coolify), pi-pages just drops static pages on one domain. See [`docs/DESIGN.md`](docs/DESIGN.md) and the shared philosophy in `../docs/building-pi-agents.md`.

## What it is (and isn't)

- **Is:** the fast, disposable path — `myr-thb-money-changer.html` → `https://pages.gylab.cc/myr-thb-money-changer`, in one publish.
- **Isn't:** a build system. It serves static files verbatim. Things needing a build (Astro/Vite/TSX) go to `pi-deployment-manager`.

## The gate

pi-pages's LLM sees **exactly four verbs** and nothing else — built-in tools (bash/read/write/edit/glob) are disabled (`pi --mode rpc --no-builtin-tools --no-extensions -nc`) and the active set is pinned to the verbs at session start.

| verb | r/w | does |
|------|-----|------|
| `publish` | write | copy a caller-named `.html`/static-folder into the site + deploy; returns the URL |
| `list` | read | list published artifacts |
| `unpublish` | write | remove an artifact by slug + redeploy |
| `status` | read | Pages project + last deployment status |

Two code-enforced guarantees (in `shared/sandbox.ts`, never trusted to the LLM):

1. **Source allowlist** — only a single `.html`/`.htm` file, or a folder whose every file is a static web asset and that has an `index.html`. A `.env`/`.ts`/secret is refused before a byte is read.
2. **Write confinement** — pi-pages only ever writes inside `artifacts_root` (the canonical content set; each artifact is one entry).

Guards fail closed: a slug collision is **refused** (the agent asks the caller to overwrite or rename); a post-deploy health probe must confirm the artifact actually serves or the result is `failed`.

## Setup

```bash
npm install
cp config.json.example config.json   # fill cloudflare.api_token (Pages:Edit) + account_id
npm run typecheck
```

The DNS record for the custom domain (a proxied `CNAME <domain> -> <project>.pages.dev`) is a one-time setup done out-of-band; the Pages:Edit token never needs DNS access.

## Use it

Over the `publish-via-pages` skill (the RPC driver):

```bash
bun .claude/skills/publish-via-pages/tools/session.ts publish "Publish /abs/path/to/doc.html"
```

It returns a JSON line; on success `result.url` is the shareable link.
