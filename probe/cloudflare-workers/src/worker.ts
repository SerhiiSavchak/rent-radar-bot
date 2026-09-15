import { runFixtureProbe, runLiveOlxProbe } from "../../../src/probe/cloudflare-source-probe.ts";

export type ProbeEnv = {
  PROBE_TOKEN?: string;
};

function authorized(request: Request, env: ProbeEnv): boolean {
  const expected = env.PROBE_TOKEN;
  if (!expected) {
    return false;
  }
  const header = request.headers.get("x-probe-token");
  return header === expected;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export default {
  async fetch(request: Request, env: ProbeEnv): Promise<Response> {
    if (!authorized(request, env)) {
      return json({ error: "unauthorized" }, 401);
    }
    if (request.method !== "GET") {
      return json({ error: "method_not_allowed" }, 405);
    }
    const url = new URL(request.url);
    if (url.pathname === "/fixtures") {
      return json(runFixtureProbe("cloudflare-workers"));
    }
    if (url.pathname === "/live-olx") {
      const live = await runLiveOlxProbe();
      return json({
        generatedAt: new Date().toISOString(),
        runtime: "cloudflare-workers",
        cpuWarning:
          "elapsedMs is wall time. Platform CPU is not in this JSON; read cpuTime from wrangler tail / Workers Logs after deploy.",
        apartments: live.apartments,
        houses: live.houses,
      });
    }
    return json({ error: "not_found", routes: ["/fixtures", "/live-olx"] }, 404);
  },
};
