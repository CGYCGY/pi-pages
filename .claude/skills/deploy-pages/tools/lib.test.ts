import { describe, expect, test } from "bun:test";

import { BASE_PROMPT, piArgs } from "./lib.ts";

describe("piArgs", () => {
  const args = piArgs("/x/pi-pages", { stateDir: "/tmp/s", model: "m", thinking: "low" });

  test("passes the base prompt via --system-prompt", () => {
    const i = args.indexOf("--system-prompt");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe(BASE_PROMPT);
  });

  test("keeps the gate flags", () => {
    for (const f of ["--no-extensions", "--no-builtin-tools", "-nc", "-ns", "-np"]) expect(args).toContain(f);
  });

  test("never trusts project-local files", () => {
    expect(args).not.toContain("-a");
    expect(args).not.toContain("--approve");
  });
});
