import type { FetchResultKind } from "../../domain/source.ts";

const CHALLENGE_MARKERS = [
  /cdn-cgi\/challenge/i,
  /cf-browser-verification/i,
  /attention required!?\s*\|\s*cloudflare/i,
  /just a moment/i,
  /enable javascript and cookies to continue/i,
  /sorry, you have been blocked/i,
  /<title>\s*access denied/i,
  /<title>\s*403 forbidden/i,
];

export function isRieltorChallengeHtml(html: string): boolean {
  return CHALLENGE_MARKERS.some((marker) => marker.test(html));
}

export function isRieltorTransportBlocked(input: {
  status: number;
  bodyText?: string;
}): boolean {
  if (input.status === 403 || input.status === 429) {
    return true;
  }
  if (input.status === 200 && input.bodyText && isRieltorChallengeHtml(input.bodyText)) {
    return true;
  }
  return false;
}

/**
 * A blocked transport always wins over catalog HTML success.
 * Partial listings from an earlier 200 page do not hide a later 403/challenge.
 */
export function resolveRieltorInspectKind(input: {
  parserFailure: boolean;
  httpError: boolean;
  blocked: boolean;
  uniqueCount: number;
  sawStructure: boolean;
}): FetchResultKind {
  if (input.blocked) {
    return "http_error";
  }
  if (input.parserFailure && input.uniqueCount === 0) {
    return "parser_failure";
  }
  if (input.httpError && input.uniqueCount === 0) {
    return "http_error";
  }
  if (input.uniqueCount === 0 && input.sawStructure) {
    return "valid_empty";
  }
  if (input.uniqueCount > 0) {
    return "ok";
  }
  return "http_error";
}
