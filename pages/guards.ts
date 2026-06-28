// Fail-closed guards in code (not LLM judgment). The publish-health guard is the deployment
// analog of pi-deployment-manager's: after a deploy, confirm the artifact actually serves on
// the live site, so a "deployed" result can't lie about a broken upload.

export interface Reachability {
  healthy: boolean;
  status?: number;
  detail: string;
}

/**
 * Probe a URL until it serves 2xx/3xx, with a few retries (a fresh deploy + cert/edge
 * propagation can lag a second or two). Never throws — returns a verdict.
 */
export async function assertReachable(
  url: string,
  opts: { retries?: number; delayMs?: number; timeoutMs?: number } = {},
): Promise<Reachability> {
  const retries = opts.retries ?? 6;
  const delayMs = opts.delayMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  let lastDetail = "no attempt";
  let lastStatus: number | undefined;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(url, { redirect: "follow", signal: ctrl.signal });
      clearTimeout(t);
      lastStatus = res.status;
      if (res.status >= 200 && res.status < 400) {
        return { healthy: true, status: res.status, detail: `HTTP ${res.status} on attempt ${attempt}` };
      }
      lastDetail = `HTTP ${res.status}`;
    } catch (err) {
      lastDetail = (err as Error).name === "AbortError" ? "request timed out" : (err as Error).message;
    }
    if (attempt < retries) await new Promise((r) => setTimeout(r, delayMs));
  }
  return { healthy: false, status: lastStatus, detail: `unreachable after ${retries} tries (${lastDetail})` };
}
