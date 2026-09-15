# HTTP-only runtime research (docs only, not provisioned)

Date: 2026-09-15  
Workload now: TypeScript collection over **ordinary HTTP** every ~10 minutes (144 cycles/day, 4 464 / 31-day month). Headed Chromium is **not** a demonstrated requirement.

No accounts, billing, or VMs were created. OLX accepting a provider's egress IP is **not** implied by any of these docs.

## Deno Deploy (evaluated first)

Official sources:

- [Acceptable use](https://docs.deno.com/deploy/acceptable_use_policy/) — **Scrapers** are listed under Not Acceptable Use (page last updated 2025-10-07).
- [Pricing](https://deno.com/deploy/pricing) — Free: 1M inbound requests/month, 20 GiB egress, 10 CPU-hr, 150 GiB-hr memory. Idle apps shut down after ~20–30 s.
- [Cron](https://docs.deno.com/deploy/cron/) — `Deno.cron()`; overlapping runs skipped; free orgs ≤10 cron jobs/revision. Common examples include `*/15 * * * *`; `*/10 * * * *` is a normal 5-field expression (not contradicted). Each cron execution is billed as one inbound HTTP request.
- [Limits](https://docs.deno.com/deploy/pricing_and_limits/) — 512 MB memory on Deploy Classic docs; violation of AUP risks account termination.

**Disqualified for this workload:** outbound collection of third-party listing HTML/JSON is scraping. That is a policy block, not a quota issue. Additional mismatches even if AUP were ignored: no persistent local filesystem for current `node:sqlite` dedup; would need Deno KV or later PostgreSQL; Node 22 + `tsx` + `node:sqlite` is not the native programming model.

Usage math **if it were allowed** (formulas only; cycle duration and bytes unmeasured):

- Inbound cron invocations: `4 464 / month` ≪ 1M free.
- Egress: `E = 4 464 × B_out`. Free until `B_out ≤ 20 GiB / 4 464 ≈ 4.7 MiB/cycle`.
- CPU: `C = 4 464 × t_cpu_hours`. Free until `t_cpu ≤ 10 / 4 464 ≈ 8.1 s` of CPU (not wall) per cycle.

Missing measurements: wall time, CPU time, and outbound bytes per cycle.

## Cloudflare Workers Free (second candidate, weak)

Official sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

- Cron Triggers: min interval 1 minute; 5 crons/account on Free; 15 min wall clock per scheduled invocation.
- Free CPU: **10 ms per Cron Trigger**. Waiting on `fetch` does not count; HTML/JSON parse does. Four source pages of ~1 MB HTML are likely to exceed 10 ms CPU consistently.
- Requests: 100k/day ≫ 144/day.
- No `node:sqlite` persistent files; D1/KV rewrite required. External PostgreSQL later needs Workers TCP / Hyperdrive (not demonstrated, may leave Free).
- Card not required for Free. Over-limit invocations fail rather than billing (Free). Paid plan bills CPU.

**Not recommended to test first:** CPU budget is a structural mismatch for this parser, and the current SQLite file does not port.

## Oracle Always Free VM (recommended to TEST)

Official source: [Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm).

For **HTTP-only** Node the relevant shape is **`VM.Standard.E2.1.Micro`** (x86, 1 GB), not Ampere A1. A1 remains available (2 OCPU / 12 GB after the 2026 cut) but is not preferred here merely because it fit an earlier browser hypothesis.

| Item | Always Free E2.1.Micro |
|------|-------------------------|
| Permanence | Always Free compute, not trial credits |
| Arch / RAM | x86, 1 GB — enough for Node HTTP; Chromium not required |
| Schedule | systemd timer / cron on a 24/7 VM; unattended restart is ordinary Linux (not demonstrated) |
| Disk / IP / egress | Always Free boot volume + public IP; **10 TB/month** outbound |
| Signup | Card + phone; authorization hold; **no invoice while the tenancy stays Free** ([FAQ](https://www.oracle.com/cloud/free/faq/)) |
| Sleep | None. Idle reclaim if 7-day 95th CPU **and** network **and** (A1 only) memory all &lt; 20%. E2 micros: capacity / idle rules still apply; **out of host capacity** is documented |
| Spend cap | Hard: a non-upgraded Free tenancy cannot emit a bill. Usage above Always Free limits on an **upgraded** tenancy is charged |
| node:sqlite / later PostgreSQL | Full VM: local SQLite works; outbound TCP to a future Postgres is ordinary |
| AUP | No explicit “no scrapers” clause equivalent to Deno Deploy; target-site ToS remain the operator’s risk |

Usage: 744 instance-hours/month is the VM itself (covered). Traffic: `E = 4 464 × B_out`; 10 TB threshold is `B_out ≤ ~2.3 GB/cycle` (not a realistic constraint). **Unmeasured:** cycle wall time, RSS, CPU p95 (idle-reclaim risk if CPU and net stay &lt; 20% for 7 days).

## GCP e2-micro Always Free (backup, weaker spend control)

Official: [Free cloud features](https://docs.cloud.google.com/free/docs/free-cloud-features).

- 1 non-preemptible `e2-micro` / month in `us-west1` / `us-central1` / `us-east1`; ~1 GB RAM; 30 GB-months disk; **1 GB/month** egress from North America.
- After the 90-day trial a **paid billing account** is required to keep Always Free resources. Over-limit usage is billed. Standard budgets are **alerts**, not a hard stop unless a Spend Cap budget actually covers Compute Engine (eligibility not verified here).
- Card required. No sleep. x86 Node + sqlite fine.

Egress math: free only if `4 464 × B_out ≤ 1 GB` ⇒ `B_out ≤ ~240 KB/cycle`. Four HTML pages inbound do **not** count as egress; Telegram later and any request bodies do. Unmeasured.

## Disqualified / not padded

| Option | Why |
|--------|-----|
| Deno Deploy | AUP: scrapers forbidden |
| GitHub Actions | Policy: hosted runners not for unrelated production polling; Free private repos 2 000 min/month vs 4 464; cron may delay or drop ([Actions additional terms](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features), [limits](https://docs.github.com/en/actions/reference/limits)) |
| Val Town Free | Minimum cron interval **15 minutes** — cannot meet ~10 minutes |
| Fly.io | No free allowance for new customers (pay-as-you-go) |
| Cloud Run Jobs | 4 464 × 1-minute minimum vCPU-seconds exceeds the always-free CPU-second grant (see earlier arithmetic) |
| AWS / Azure free | Time-boxed credits, not permanent zero-cost VMs |

## Recommended candidate to TEST (not adopt)

**Oracle Always Free `VM.Standard.E2.1.Micro` (x86, 1 GB)** running the existing Node 22 job under systemd every 10 minutes.

Smallest hosted experiment (not approved / not provisioned here):

1. Create the Free tenancy and one E2.1.Micro in the home region; record capacity failures.
2. Install Node 22, clone the repo, run **only** `npm run live:olx` (ordinary HTTP, corrected Lviv params). Require real Lviv listings, category, seller evidence — not HTTP 200 alone.
3. Repeat the same query ~10 minutes later and once from a fresh process.
4. If OLX returns 403 from that IP, record NOT WORKING for this host; do not add proxies or stealth. Optionally repeat the same smoke test on a GCP e2-micro if one is already authorized.

Remaining risks: OLX/CloudFront IP reputation; Oracle capacity and idle reclaim; DIM.RIA official API quota still incompatible with 10-minute polling (HTML fallback is the current path); PostgreSQL hosting cost is a later-phase question and is not covered by “free VM compute”.
