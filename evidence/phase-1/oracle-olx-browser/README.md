# Oracle OLX browser probe evidence

Output of `npm run live:olx:browser-experiment` (one bounded Playwright Chromium cycle).

## On the Ubuntu Always Free VM

```bash
cd ~/rent-radar-bot   # or your clone path
git pull
npm ci
# Install Chromium + OS deps for Playwright (exact):
npx playwright install --with-deps chromium

OLX_BROWSER_OUT_DIR=evidence/phase-1/oracle-olx-browser \
  npm run live:olx:browser-experiment
```

Writes `cycle-1.json` here. Commit after review.

Constraints (enforced by script notes): no proxies, stealth plugins, CAPTCHA solving, IP rotation, fingerprint spoofing, or WAF bypass. Does not use production `OlxSource`.
