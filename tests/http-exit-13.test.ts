import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { LunSource } from "../src/sources/lun/lun.source.ts";
import { AppError } from "../src/utils/errors.ts";
import { httpGet } from "../src/utils/http.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const tsxCli = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/http-unsettled-exit.ts", import.meta.url));
const originalFetch = globalThis.fetch;

type ChildResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  events: Array<Record<string, unknown>>;
};

function runChild(mode: string): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, fixture, mode], {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? "",
        PATHEXT: process.env.PATHEXT ?? "",
        SystemRoot: process.env.SystemRoot ?? "",
        TEMP: process.env.TEMP ?? "",
        TMP: process.env.TMP ?? "",
      },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`child ${mode} still running after 8s`));
    }, 8_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      const events = stdout
        .split(/\r?\n/)
        .filter((line) => line.startsWith("RRB_EXIT13 "))
        .map((line) => JSON.parse(line.slice("RRB_EXIT13 ".length)) as Record<string, unknown>);
      resolve({ code, stdout, stderr, events });
    });
  });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("httpGet settles when fetch does not", () => {
  it("rejects with TIMEOUT when fetch ignores abort", async () => {
    let calls = 0;
    globalThis.fetch = () => {
      calls += 1;
      return new Promise(() => undefined);
    };
    const error = await httpGet("https://lun.example/rent", {
      timeoutMs: 40,
      maxRetries: 0,
    }).then(
      () => {
        throw new Error("expected timeout");
      },
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: "TIMEOUT", retryable: true });
    expect(calls).toBe(1);
  });

  it("rejects with TIMEOUT when the body never arrives", async () => {
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            pull() {
              return new Promise(() => undefined);
            },
          }),
        ),
      );
    await expect(
      httpGet("https://lun.example/rent", { timeoutMs: 40, maxRetries: 0 }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("retries a stalled attempt and then returns the next response", async () => {
    let calls = 0;
    globalThis.fetch = () => {
      calls += 1;
      if (calls === 1) {
        return new Promise(() => undefined);
      }
      return Promise.resolve(new Response("page-2", { status: 200 }));
    };
    const result = await httpGet("https://lun.example/rent", { timeoutMs: 40, maxRetries: 1 });
    expect(result.status).toBe(200);
    expect(result.bodyText).toBe("page-2");
    expect(calls).toBe(2);
  });

  it("does not report a parser-empty success for a network failure", async () => {
    globalThis.fetch = () => Promise.reject(new TypeError("connect ECONNREFUSED"));
    await expect(
      httpGet("https://lun.example/rent", { timeoutMs: 40, maxRetries: 0 }),
    ).rejects.toMatchObject({ code: "NETWORK" });
  });
});

describe("LUN does not stay pending when its page request ignores abort", () => {
  it("returns http_error and lets the caller continue", async () => {
    globalThis.fetch = () => new Promise(() => undefined);
    const lun = new LunSource({
      safetyCap: 2,
      categoryBudgetMs: 5_000,
      get: async (url) => {
        const response = await httpGet(url, { timeoutMs: 40, maxRetries: 0 });
        return { status: response.status, bodyText: response.bodyText, headers: response.headers };
      },
    });
    const started = Date.now();
    const result = await lun.inspectLatest({ includeHouses: false });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.resultKind).toBe("http_error");
    expect(result.health.healthy).toBe(false);
    expect(result.listings).toEqual([]);
    expect(result.rawNotes?.some((note) => note.includes("timeout"))).toBe(true);
  });
});

describe("child process exit code", () => {
  it("does not exit 13 when fetch never settles", async () => {
    const child = await runChild("hang");
    expect(child.code).toBe(0);
    expect(child.stderr).not.toContain("unsettled top-level await");
    expect(child.events[0]).toMatchObject({
      label: "hang",
      settled: true,
      code: "TIMEOUT",
      fetchCalls: 1,
    });
    expect(child.events.at(-1)).toMatchObject({ unhandled: 0 });
  });

  it("does not exit 13 when the response body never settles", async () => {
    const child = await runChild("body");
    expect(child.code).toBe(0);
    expect(child.stderr).not.toContain("unsettled top-level await");
    expect(child.events[0]).toMatchObject({ label: "body", settled: true, code: "TIMEOUT" });
    expect(child.events.at(-1)).toMatchObject({ unhandled: 0 });
  });

  it("still classifies an abort-aware fetch as TIMEOUT", async () => {
    const child = await runChild("honored");
    expect(child.code).toBe(0);
    expect(child.events[0]).toMatchObject({
      label: "honored",
      settled: true,
      code: "TIMEOUT",
      fetchCalls: 1,
    });
    expect(child.events.at(-1)).toMatchObject({ unhandled: 0 });
  });

  it("finishes the poll cycle after a hung LUN request and does not send Telegram", async () => {
    const child = await runChild("cycle");
    expect(child.code).toBe(0);
    expect(child.stderr).not.toContain("unsettled top-level await");
    expect(child.events[0]).toMatchObject({
      label: "cycle",
      settled: true,
      order: ["domria", "lun", "olx"],
      lunKind: "transport_failure",
      lunOk: false,
      olxOk: true,
      sentOk: 0,
      sentFailed: 0,
      hasSourceFailures: true,
      telegramCalls: 0,
      fetchCalls: 1,
    });
    expect(child.events.at(-1)).toMatchObject({ unhandled: 0 });
  });
});
