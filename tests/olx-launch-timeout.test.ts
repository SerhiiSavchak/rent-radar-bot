import { describe, expect, it } from "vitest";
import type { Browser } from "playwright";
import { extractOlxListingsViaBrowser } from "../src/sources/olx/olx-browser.extract.ts";

describe("OLX browser launch timeout", () => {
  it("stops a hanging chromium.launch and closes it if it appears later", async () => {
    let closed = false;
    const launch = () =>
      new Promise<Browser>((resolve) => {
        setTimeout(() => {
          resolve({ close: async () => { closed = true; } } as Browser);
        }, 40);
      });
    await expect(
      extractOlxListingsViaBrowser({
        timeoutMs: 1_000,
        totalBudgetMs: 5_000,
        launchTimeoutMs: 15,
        launch,
      }),
    ).rejects.toThrow("chromium.launch timed out after 15ms");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(true);
  });
});
