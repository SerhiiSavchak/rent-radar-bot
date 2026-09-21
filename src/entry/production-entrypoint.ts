/** The only production poll that persists listings and talks to Telegram. */
export const CANONICAL_PRODUCTION_ENTRYPOINT = "src/scripts/test-telegram-poll.ts";

export function refuseUnsafeOneshot(): {
  exitCode: 2;
  canonicalEntrypoint: string;
  message: string;
} {
  return {
    exitCode: 2,
    canonicalEntrypoint: CANONICAL_PRODUCTION_ENTRYPOINT,
    message:
      "src/index.ts does not collect, persist, or deliver. A listing is recorded only by the SQLite outbox inside the canonical poller, and only marked sent after Telegram accepts it.",
  };
}
