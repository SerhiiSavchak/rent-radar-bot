import type { Listing, ListingSource } from "./listing.ts";

export type FetchListingsOptions = {
  limit?: number;
  includeHouses?: boolean;
  includeApartments?: boolean;
  preferOwners?: boolean;
  /**
   * Committed newest publication already covered, per category
   * (RIELTOR apartment/house; OLX maps apartments→apartment, houses→house).
   */
  publicationWatermarks?: Partial<Record<"apartment" | "house", Date>>;
  /** In-progress backlog cursor. Does not replace the committed watermark. */
  rieltorCatchup?: Partial<
    Record<"apartment" | "house", { target: string; resumePage: number }>
  >;
  /**
   * Monitoring start for an existing RIELTOR baseline that has no watermark yet.
   * A brand-new installation leaves this unset and only seeds page 1.
   */
  rieltorBootstrapTarget?: Date;
  /** OLX browser catch-up cursor (apartments→apartment, houses→house). */
  olxCatchup?: Partial<
    Record<"apartment" | "house", { target: string; resumePage: number }>
  >;
  /** Existing OLX baseline without a watermark — bootstrap catch-up target. */
  olxBootstrapTarget?: Date;
  /** DIM.RIA ids whose listing page was already read. Detail fetches skip these. */
  domriaKnownIds?: readonly string[];
};

export type FetchResultKind =
  | "ok"
  | "valid_empty"
  | "parser_failure"
  | "http_error"
  | "rate_limited"
  | "disabled";

export type SourceIntegrity = {
  httpStatus?: number | undefined;
  hasExpectedMarkers?: boolean | undefined;
  hasJsonLd?: boolean | undefined;
  hasRscCards?: boolean | undefined;
  extractedCardCount?: number | undefined;
  validatedCardCount?: number | undefined;
  validationRatio?: number | undefined;
};

export type SourceHealth = {
  source: ListingSource;
  healthy: boolean;
  checkedAt: Date;
  latencyMs?: number | undefined;
  message?: string | undefined;
  httpStatus?: number | undefined;
  transport?: string | undefined;
  resultKind?: FetchResultKind | undefined;
};

export type IncrementalCoverage = {
  pagesFetched: number;
  cardsFetched: number;
  boundaryReached: boolean;
  coverageTruncated: boolean;
  oldestObservedPublication?: string;
  newestObservedPublication?: string;
  /** Present only when this category's walk closed the gap safely. */
  committedBoundary?: Partial<Record<"apartment" | "house", string>>;
  /** null clears a stored cursor. Absent means that category was not updated. */
  catchup?: Partial<Record<"apartment" | "house", { target: string; resumePage: number } | null>>;
  /** DIM.RIA ids safely remembered after a successful listing-page read. */
  retainedSourceIds?: string[];
};

export type SourceFetchResult = {
  listings: Listing[];
  health: SourceHealth;
  transport: string;
  dataKind: "LIVE DATA" | "MOCK DATA" | "FIXTURE DATA";
  httpStatus?: number | undefined;
  rawNotes?: string[] | undefined;
  resultKind?: FetchResultKind | undefined;
  integrity?: SourceIntegrity | undefined;
  coverage?: IncrementalCoverage | undefined;
};

export interface ListingSourceAdapter {
  readonly source: ListingSource;
  fetchLatest(options?: FetchListingsOptions): Promise<Listing[]>;
  inspectLatest(options?: FetchListingsOptions): Promise<SourceFetchResult>;
  healthCheck(): Promise<SourceHealth>;
}
