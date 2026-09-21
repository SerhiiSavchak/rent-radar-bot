import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config/env.ts";
import {
  DOMRIA_BUDGET_INTERVALS_SECONDS,
  decideDomriaTransport,
  domriaOfficialVolume,
} from "../src/sources/domria/domria-budget.ts";

describe("DIM.RIA official request budget", () => {
  it("shows the free package cannot fund a blind official poll at 5–60 minutes", () => {
    const rows = DOMRIA_BUDGET_INTERVALS_SECONDS.map((intervalSeconds) =>
      domriaOfficialVolume({ intervalSeconds, searchesPerPoll: 2, infoPerPoll: 2 }),
    );
    for (const row of rows) {
      expect(row.exceedsMonthly).toBe(true);
      expect(row.compatibleWithFreeTier).toBe(false);
    }
    const tenMinutes = rows.find((row) => row.intervalSeconds === 600);
    expect(tenMinutes?.requestsPerPoll).toBe(4);
    expect(tenMinutes?.requestsPerHour).toBeCloseTo(24);
    expect(tenMinutes?.requestsPerMonth).toBeCloseTo(17_280);
  });

  it("keeps the legacy 2-search + 8-info shape over quota at every listed interval", () => {
    for (const intervalSeconds of DOMRIA_BUDGET_INTERVALS_SECONDS) {
      const volume = domriaOfficialVolume({ intervalSeconds, searchesPerPoll: 2, infoPerPoll: 8 });
      expect(volume.requestsPerPoll).toBe(10);
      expect(volume.compatibleWithFreeTier).toBe(false);
    }
  });

  it("allows a slow official cadence that stays inside 1000/month and 30/hour", () => {
    const volume = domriaOfficialVolume({
      intervalSeconds: 10_800,
      searchesPerPoll: 2,
      infoPerPoll: 2,
    });
    expect(volume.requestsPerMonth).toBeCloseTo(960);
    expect(volume.requestsPerHour).toBeLessThanOrEqual(30);
    expect(volume.compatibleWithFreeTier).toBe(true);
  });

  it("uses public HTML for production even when an API key exists", () => {
    const decision = decideDomriaTransport({
      mode: "html",
      hasApiKey: true,
      intervalSeconds: 600,
      searchesPerPoll: 2,
      infoPerPoll: 2,
    });
    expect(decision.transport).toBe("html");
    expect(decision.officialRequestsPerPoll).toBe(0);
  });

  it("refuses official mode when the real poll tick would exceed the free package", () => {
    const decision = decideDomriaTransport({
      mode: "official",
      hasApiKey: true,
      intervalSeconds: 600,
      searchesPerPoll: 2,
      infoPerPoll: 2,
    });
    expect(decision.transport).toBe("html");
    expect(decision.officialRequestsPerPoll).toBe(0);
    expect(decision.reason).toContain("refused");
  });

  it("reports zero official requests for the default config at a 10-minute telegram tick", () => {
    const config = loadConfig({
      DOMRIA_API_KEY: "test-key",
      POLL_INTERVAL_SECONDS: "600",
    });
    expect(config.domriaAcquisition).toBe("html");
    const decision = decideDomriaTransport({
      mode: config.domriaAcquisition,
      hasApiKey: true,
      intervalSeconds: 600,
      searchesPerPoll: 2,
      infoPerPoll: config.domriaMaxInfoPerPoll,
    });
    expect(decision.officialRequestsPerPoll).toBe(0);
  });
});
