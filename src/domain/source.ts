import type { Listing, ListingSource } from "./listing.ts";

export type FetchListingsOptions = {
  limit?: number;
  includeHouses?: boolean;
  includeApartments?: boolean;
  preferOwners?: boolean;
};

export type FetchResultKind = "ok" | "valid_empty" | "parser_failure" | "http_error" | "disabled";

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

export type SourceFetchResult = {
  listings: Listing[];
  health: SourceHealth;
  transport: string;
  dataKind: "LIVE DATA" | "MOCK DATA" | "FIXTURE DATA";
  httpStatus?: number | undefined;
  rawNotes?: string[] | undefined;
  resultKind?: FetchResultKind | undefined;
  integrity?: SourceIntegrity | undefined;
};

export interface ListingSourceAdapter {
  readonly source: ListingSource;
  fetchLatest(options?: FetchListingsOptions): Promise<Listing[]>;
  inspectLatest(options?: FetchListingsOptions): Promise<SourceFetchResult>;
  healthCheck(): Promise<SourceHealth>;
}
