import { describe, expect, it } from "vitest";
import { runFixtureProbe } from "../src/probe/cloudflare-source-probe.ts";
import { largestAvailableFixture } from "../src/probe/fixtures.ts";

describe("Cloudflare source probe fixtures", () => {
  it("exercises the real parsers on sanitized representative and large fixtures", () => {
    const report = runFixtureProbe("local-node");
    const byFixture = Object.fromEntries(report.fixtures.map((item) => [item.fixture, item]));
    expect(byFixture["representative-2-offers"]?.resultKind).toBe("ok");
    expect(byFixture["representative-2-offers"]?.accepted).toBe(2);
    expect(byFixture["wide-40-offers"]?.accepted).toBe(40);
    expect(byFixture["catalog-20-cards"]?.accepted).toBe(20);
    expect(byFixture["catalog-20-cards"]?.sellerTypes.owner).toBeGreaterThan(0);
    expect(byFixture["rsc-one-card"]?.resultKind).toBe("ok");
    expect(byFixture["initial-state-one-listing"]?.resultKind).toBe("ok");
    expect(byFixture["initial-state-one-listing"]?.sellerTypes.owner).toBe(1);
    const largest = report.fixtures.find((item) => item.fixture.includes("1_2MiB"));
    expect(largest?.bytes).toBeGreaterThan(1_000_000);
    expect(largest?.accepted).toBe(20);
    expect(largestAvailableFixture().name).toContain("1_2MiB");
  });
});
