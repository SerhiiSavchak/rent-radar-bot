import { describe, expect, it } from "vitest";
import {
  LUN_FLATS_URL,
  LUN_HOUSES_URL,
  LUN_POLL_PAGE_BUDGET,
  buildLunCategoryPageUrl,
} from "../src/sources/lun/lun.source.ts";

describe("LUN pagination URL contract", () => {
  it("keeps page 1 as the bare category URL", () => {
    expect(buildLunCategoryPageUrl(LUN_FLATS_URL, 1)).toBe(LUN_FLATS_URL);
    expect(buildLunCategoryPageUrl(LUN_HOUSES_URL, 0)).toBe(LUN_HOUSES_URL);
  });

  it("uses live-verified ?page=N for deeper pages (not /page/N or offset)", () => {
    expect(buildLunCategoryPageUrl(LUN_FLATS_URL, 2)).toBe(
      "https://lun.ua/rent/lviv/flats?page=2",
    );
    expect(buildLunCategoryPageUrl(LUN_HOUSES_URL, 3)).toBe(
      "https://lun.ua/rent/lviv/houses?page=3",
    );
    expect(LUN_POLL_PAGE_BUDGET).toBe(2);
  });
});
