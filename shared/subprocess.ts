// The one place pi-pages shells out. The Cloudflare Pages API calls are native HTTP; the
// only real subprocess is `wrangler pages deploy` (uploads the artifacts folder). Capture
// stdout/stderr, hard timeout → SIGKILL.

import { spawn } from "node:child_process";

export interface RunResult {
  stdout: string;
  stderr: string;
  /** null when the process was killed (timeout) or never spawned (spawn error). */
  code: number | null;
}

export interface RunOpts {
  cwd: string;
  /** Extra env merged over process.env (the Cloudflare token rides here, never argv). */
  env?: Record<string, string>;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export function runCommand(bin: string, args: string[], opts: RunOpts): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<RunResult>((resolve) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ stdout, stderr: stderr + `\n[timeout after ${timeoutMs}ms]`, code: null });
    }, timeoutMs);
    child.stdout?.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + "\n" + err.message, code: null });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
  });
}
