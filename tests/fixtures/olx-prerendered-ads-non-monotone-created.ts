/**
 * Minimal prerendered-state shaped fixture: ads array order is intentionally
 * non-monotone on createdTime (older organic before newer organic), matching
 * the live OLX HTML catalog observation (2026-09-26 sort gate BLOCKED).
 * Used to prove extractListingAdsFromPrerenderedState does not reorder ads.
 */
export const olxPrerenderedAdsNonMonotoneCreatedFixture = {
  listing: {
    listing: {
      ads: [
        {
          id: 924728316,
          title: "Older organic",
          url: "https://www.olx.ua/d/uk/obyavlenie/older-ID1.html",
          createdTime: "2026-05-28T18:00:03+03:00",
          lastRefreshTime: "2026-09-26T09:26:47+03:00",
          isPromoted: false,
          location: { cityName: "Львів" },
        },
        {
          id: 936000137,
          title: "Promoted slot",
          url: "https://www.olx.ua/d/uk/obyavlenie/promo-ID2.html",
          createdTime: "2026-09-26T09:11:33+03:00",
          lastRefreshTime: "2026-09-26T09:14:09+03:00",
          isPromoted: true,
          promotion: { top_ad: true, highlighted: true },
          location: { cityName: "Львів" },
        },
        {
          id: 935998907,
          title: "Newer organic after older",
          url: "https://www.olx.ua/d/uk/obyavlenie/newer-ID3.html",
          createdTime: "2026-09-26T08:41:00+03:00",
          lastRefreshTime: "2026-09-26T08:42:03+03:00",
          isPromoted: false,
          location: { cityName: "Львів" },
        },
      ],
    },
  },
} as const;
