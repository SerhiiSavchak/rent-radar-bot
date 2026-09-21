# Claim vs repository evidence (2026-09-15)

Git: branch created from `main` @ `0bf0abb`. Remote: `origin` → GitHub `SerhiiSavchak/rent-radar-bot`. Only remote head: `main`. Working tree before recovery: clean.

See `docs/PHASE_1_DECISION.md` for the full table.

Confirmed in-repo:

- TypeScript service with isolated adapters for DIM.RIA, LUN, OLX (not RIELTOR).
- Live scripts `npm run live:*`.
- SQLite prototype, Zod config, Vitest unit tests.
- `docs/SOURCE_RESEARCH.md` dated 2026-09-13.
- Characteristic 1437 mapping in `src/sources/domria/domria.types.ts`.
- LUN `urlRaw` → `metadata.originalUrl`.

Quality on this branch (2026-09-15): `npm run typecheck` pass, `npm run lint` pass, `npm test` **22** tests / 6 files.

Not in-repo before this branch:

- 103 tests, Chromium/Xvfb OLX runtime, RIELTOR source adapter, `AGENTS.md`, prior `evidence/phase-1`, hosted soak.
