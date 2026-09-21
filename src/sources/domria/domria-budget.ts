/**
 * DIM.RIA free package is about 1000 requests/month and 30 requests/hour.
 * A 10-minute poll cannot spend even one official request per cycle.
 * Normal production acquisition is public HTML and performs zero official calls.
 */

export const DOMRIA_FREE_HOURLY_LIMIT = 30;
export const DOMRIA_FREE_MONTHLY_LIMIT = 1000;
export const DOMRIA_BUDGET_DAYS = 30;

export type DomriaAcquisitionMode = "html" | "official";

export type DomriaOfficialVolume = {
  intervalSeconds: number;
  searchesPerPoll: number;
  infoPerPoll: number;
  requestsPerPoll: number;
  pollsPerHour: number;
  pollsPerMonth: number;
  requestsPerHour: number;
  requestsPerMonth: number;
  exceedsHourly: boolean;
  exceedsMonthly: boolean;
  compatibleWithFreeTier: boolean;
};

export function domriaOfficialVolume(input: {
  intervalSeconds: number;
  searchesPerPoll: number;
  infoPerPoll: number;
}): DomriaOfficialVolume {
  const intervalSeconds = input.intervalSeconds;
  const searchesPerPoll = input.searchesPerPoll;
  const infoPerPoll = input.infoPerPoll;
  const requestsPerPoll = searchesPerPoll + infoPerPoll;
  const pollsPerHour = 3600 / intervalSeconds;
  const pollsPerMonth = (DOMRIA_BUDGET_DAYS * 24 * 3600) / intervalSeconds;
  const requestsPerHour = requestsPerPoll * pollsPerHour;
  const requestsPerMonth = requestsPerPoll * pollsPerMonth;
  const exceedsHourly = requestsPerHour > DOMRIA_FREE_HOURLY_LIMIT;
  const exceedsMonthly = requestsPerMonth > DOMRIA_FREE_MONTHLY_LIMIT;
  return {
    intervalSeconds,
    searchesPerPoll,
    infoPerPoll,
    requestsPerPoll,
    pollsPerHour,
    pollsPerMonth,
    requestsPerHour,
    requestsPerMonth,
    exceedsHourly,
    exceedsMonthly,
    compatibleWithFreeTier: !exceedsHourly && !exceedsMonthly,
  };
}

/**
 * The source is invoked on every poller tick. DOMRIA_POLL_INTERVAL_SECONDS is not
 * a separate scheduler, so the binding interval is the fastest configured tick.
 */
export function bindingPollIntervalSeconds(
  input: { pollIntervalSeconds: number },
  env: Record<string, string | undefined> = process.env,
): number {
  const ticks = [input.pollIntervalSeconds];
  const telegramMs = Number(env.TELEGRAM_POLL_INTERVAL_MS);
  if (Number.isFinite(telegramMs) && telegramMs >= 1000) {
    ticks.push(telegramMs / 1000);
  }
  return Math.min(...ticks);
}

export function decideDomriaTransport(input: {
  mode: DomriaAcquisitionMode;
  hasApiKey: boolean;
  intervalSeconds: number;
  searchesPerPoll: number;
  infoPerPoll: number;
}): { transport: "html" | "official"; officialRequestsPerPoll: number; reason: string } {
  if (input.mode !== "official") {
    return {
      transport: "html",
      officialRequestsPerPoll: 0,
      reason:
        "Production DIM.RIA acquisition is public HTML embedded JSON. The official API is not called.",
    };
  }
  if (!input.hasApiKey) {
    return {
      transport: "html",
      officialRequestsPerPoll: 0,
      reason: "DOMRIA_ACQUISITION=official but DOMRIA_API_KEY is unset; using public HTML.",
    };
  }
  const budget = domriaOfficialVolume(input);
  if (!budget.compatibleWithFreeTier) {
    return {
      transport: "html",
      officialRequestsPerPoll: 0,
      reason: `Official API refused: ${Math.round(budget.requestsPerMonth)} requests/month and ${budget.requestsPerHour.toFixed(1)} requests/hour at ${input.intervalSeconds}s exceed the free package (${DOMRIA_FREE_MONTHLY_LIMIT}/month, ${DOMRIA_FREE_HOURLY_LIMIT}/hour). Using public HTML.`,
    };
  }
  return {
    transport: "official",
    officialRequestsPerPoll: budget.requestsPerPoll,
    reason: `Official API allowed: ${budget.requestsPerPoll} requests/poll at ${input.intervalSeconds}s stays inside the free package.`,
  };
}

export const DOMRIA_BUDGET_INTERVALS_SECONDS = [300, 600, 900, 1800, 3600] as const;
