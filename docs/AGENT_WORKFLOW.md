# Agent workflow

The repository is the source of truth. Reports must contain commit hashes and exact test results. Credentials stay outside git. No automatic production deployment is allowed. CI must not run live tests.

Prefer **one** local development working directory for this repository: branch from `main` → complete the task → test → commit → push → merge → return to `main`. Do not accumulate disposable git worktrees or abandoned task branches for routine work. A separate Oracle deployment checkout is not a development worktree and must not be rearranged for cleanup.

1. Create or clarify a task.
2. Create a branch from `main` in the same working directory.
3. Cursor implements only the bounded task.
4. Cursor runs deterministic validation.
5. Cursor opens or prepares a pull request.
6. CI runs automatically.
7. A human/ChatGPT reviews the diff and evidence.
8. Only after explicit approval may live tests or Oracle deployment happen.
9. Oracle pulls with `git pull --ff-only`.
10. Deployment is validated and can be rolled back.
11. After merge, switch the same working directory back to `main` and fast-forward.

## CI boundary

GitHub Actions runs `npm ci`, `npm run typecheck`, `npm run lint`, and `npm test` on pull requests and on pushes to `main`. It does not run live scripts, soak tests, browser acquisition, Telegram, or Oracle deployment.

## Secrets

Telegram test secrets belong in `~/.config/rent-radar/telegram-test.env` with mode `0600`. Do not commit `.env` files, bot tokens, or production credentials.

## Deployment

Deployment is an explicit human step after review. CI must not restart the poller. On the Oracle VM, update with `git pull --ff-only`, install dependencies deterministically, validate, then restart the single user-level systemd unit. Runtime state stays outside the repository.
