# Rent Radar Bot — agent guide

## Project purpose

Rental Radar Bot monitors long-term rental listings in Lviv and nearby areas from DOM.RIA, LUN, RIELTOR.UA, and OLX.

## Main product constraints

- Free-only runtime.
- No paid APIs, proxies, CAPTCHA services, or stealth services.
- Oracle Always Free Linux deployment.
- SQLite for the current storage layer.
- Telegram test and production credentials must never be committed.
- Runtime data, logs, and secrets must stay outside the repository.

## Seller policy

- Default delivery policy is `reject_intermediaries`.
- Allow confirmed owners, self-declared owners, and unknown/ambiguous listings.
- Reject listings with explicit intermediary/agent evidence.
- `owner_only` is a stricter legacy policy and must not be silently changed.

## Engineering rules

- Never work directly on `main`.
- Every task must use a branch and pull request.
- Make the smallest bounded change.
- Do not perform speculative refactors.
- Preserve public behavior unless the task explicitly changes it.
- Do not weaken tests to make CI green.
- Do not claim live verification from fixtures or static page access.

## Test tiers

- Unit tests.
- Integration tests.
- Live tests.
- Soak tests.

Live and soak tests must never run automatically in CI.

## Security

- Secrets belong in `~/.config/rent-radar/telegram-test.env`.
- That file must have permissions `0600`.
- Never log bot tokens, authorization headers, full secret URLs, or private user data.
- Never use production Telegram credentials for tests.
- Never commit `.env` files or credentials.

## Oracle deployment rules

- Pull with `git pull --ff-only`.
- Install dependencies deterministically.
- Validate before restart.
- Use user-level systemd units.
- Keep runtime state outside the repository.
- Never run multiple competing pollers.
- Deployment must be explicit and must never happen automatically from CI.

## Required report after every task

- Summary of changes.
- Files changed.
- Tests/commands executed.
- Exact pass/fail results.
- Known limitations.
- Commit hash.
- Whether deployment is required.
