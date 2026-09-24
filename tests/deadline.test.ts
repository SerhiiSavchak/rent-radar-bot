import { describe, expect, it } from "vitest";
import { awaitWithTimeout } from "../src/utils/deadline.ts";

describe("awaitWithTimeout", () => {
  it("rejects when the operation does not settle", async () => {
    const pending = new Promise<string>(() => undefined);
    await expect(awaitWithTimeout(pending, 20, "chromium.launch")).rejects.toThrow(
      "chromium.launch timed out after 20ms",
    );
  });

  it("returns the value when the operation settles in time", async () => {
    await expect(awaitWithTimeout(Promise.resolve("ok"), 50, "olx.display_price.body")).resolves.toBe(
      "ok",
    );
  });
});
