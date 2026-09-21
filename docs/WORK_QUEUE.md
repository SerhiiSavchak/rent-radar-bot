# Work queue

- [ ] Repair the current main baseline: typecheck, test failures, and formatting scope.
  - Description: Make `npm run typecheck`, `npm run lint`, and `npm test` pass on `main` without weakening assertions. Record which failures already exist before changing product code.
  - Suggested test tier: unit and integration.

- [ ] Define and enforce deterministic CI.
  - Description: Keep GitHub Actions limited to install, typecheck, lint, and unit/integration tests. Confirm live and soak scripts are not workflow steps.
  - Suggested test tier: unit (CI contract only).

- [ ] Verify source-level seller policy behavior.
  - Description: Check that `reject_intermediaries` sends confirmed owners, self-declared owners, and unknown listings, and drops explicit intermediary evidence. Leave `owner_only` unchanged unless a task says otherwise.
  - Suggested test tier: unit and integration.

- [ ] Verify live-source behavior separately.
  - Description: Repeat public acquisition for DOM.RIA, LUN, RIELTOR.UA, and OLX outside CI. Do not treat fixtures or a single HTTP 200 as a pass.
  - Suggested test tier: live.

- [ ] Verify Oracle deployment and systemd health.
  - Description: On the Oracle Always Free VM, confirm one user-level poller, `git pull --ff-only`, deterministic install, and runtime state outside the repo.
  - Suggested test tier: live, on the host, after explicit approval.

- [ ] Add soak-test evidence.
  - Description: Run a bounded unattended soak only when requested, and store sanitized evidence outside secret-bearing logs.
  - Suggested test tier: soak.
