// Native Cloudflare Pages API client (HTTP only). The verb CODE calls these; the LLM never
// does. Authenticates from pi-pages's config (Pages:Edit token + account id). Cloudflare
// wraps every response in {success, result, errors}. Used to ensure the project + custom
// domain exist (idempotent) and to read deploy status — wrangler does the file upload.

import { getCloudflare } from "../shared/config.ts";

const API = "https://api.cloudflare.com/client/v4";

interface CfResponse<T> {
  success: boolean;
  result: T;
  errors?: Array<{ code?: number; message?: string }>;
}

interface CfCall<T> {
  ok: boolean;
  status: number;
  json: CfResponse<T>;
}

/** Raw Cloudflare call — returns the parsed envelope + HTTP status without throwing on !success. */
async function cfRaw<T>(path: string, init?: RequestInit): Promise<CfCall<T>> {
  const c = getCloudflare();
  const headers: Record<string, string> = { Authorization: `Bearer ${c.api_token}` };
  if (init?.body) headers["Content-Type"] = "application/json";
  const res = await fetch(`${API}${path}`, { ...init, headers: { ...headers, ...(init?.headers as object) } });
  const json = (await res.json().catch(() => ({ success: false, result: null }))) as CfResponse<T>;
  return { ok: res.ok, status: res.status, json };
}

/** Cloudflare call that throws (with the API's own error text) unless success=true. */
async function cfApi<T>(path: string, init?: RequestInit): Promise<T> {
  const { ok, status, json } = await cfRaw<T>(path, init);
  if (!ok || !json.success) {
    const errs = (json.errors ?? []).map((e) => e.message).filter(Boolean).join("; ");
    throw new Error(`Cloudflare API ${path} -> HTTP ${status}${errs ? `: ${errs}` : ""}`);
  }
  return json.result;
}

function acct(): string {
  return getCloudflare().account_id;
}

export interface PagesProject {
  name: string;
  subdomain: string; // <name>.pages.dev
  production_branch?: string;
  domains?: string[];
}

/** Get a Pages project, or null if it does not exist (404). */
export async function getProject(name: string): Promise<PagesProject | null> {
  const { ok, status, json } = await cfRaw<PagesProject>(`/accounts/${acct()}/pages/projects/${name}`);
  if (status === 404) return null;
  if (!ok || !json.success) {
    const errs = (json.errors ?? []).map((e) => e.message).filter(Boolean).join("; ");
    // Cloudflare returns 404 for a missing project, but some error shapes come back as
    // success:false with a "not found" code — treat those as absent too.
    if (errs.toLowerCase().includes("not found")) return null;
    throw new Error(`getProject ${name} -> HTTP ${status}${errs ? `: ${errs}` : ""}`);
  }
  return json.result;
}

/**
 * Ensure the direct-upload Pages project exists; create it (idempotent) if missing.
 * Returns the project. A direct-upload project has no git source — wrangler pushes files to it.
 */
export async function ensureProject(name: string, productionBranch: string): Promise<PagesProject> {
  const existing = await getProject(name);
  if (existing) return existing;
  return cfApi<PagesProject>(`/accounts/${acct()}/pages/projects`, {
    method: "POST",
    body: JSON.stringify({ name, production_branch: productionBranch }),
  });
}

interface DomainEntry {
  id: string;
  name: string;
  status?: string;
}

/** List the custom domains attached to the project. */
export async function listDomains(project: string): Promise<DomainEntry[]> {
  return cfApi<DomainEntry[]>(`/accounts/${acct()}/pages/projects/${project}/domains`);
}

/**
 * Ensure a custom domain is attached to the project (idempotent). Returns the domain's
 * status. The DNS record for the domain is created out-of-band (a one-time CNAME); this
 * only registers the domain with the Pages project so it serves there.
 */
export async function ensureDomain(project: string, domain: string): Promise<{ attached: boolean; status?: string }> {
  const domains = await listDomains(project);
  const found = domains.find((d) => d.name === domain);
  if (found) return { attached: false, status: found.status };
  const created = await cfApi<DomainEntry>(`/accounts/${acct()}/pages/projects/${project}/domains`, {
    method: "POST",
    body: JSON.stringify({ name: domain }),
  });
  return { attached: true, status: created.status };
}

export interface DeploymentInfo {
  id?: string;
  url?: string; // the per-deploy <hash>.<project>.pages.dev preview URL
  status?: string;
}

/** Read the project's latest deployment (id + preview URL + stage status), if any. */
export async function latestDeployment(project: string): Promise<DeploymentInfo> {
  const list = await cfApi<Array<{ id?: string; url?: string; latest_stage?: { status?: string } }>>(
    `/accounts/${acct()}/pages/projects/${project}/deployments?per_page=1`,
  );
  const d = list[0];
  if (!d) return {};
  return { id: d.id, url: d.url, status: d.latest_stage?.status };
}
