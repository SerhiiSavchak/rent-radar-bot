# Hosting comparison (docs only, not provisioned)

Date: 2026-09-15  
Sources:

- Oracle Always Free: https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm
- Google Cloud Free Program: https://docs.cloud.google.com/free/docs/free-cloud-features

No VM, project, or billing account was created.

## Shared runtime with browser only for OLX (if OLX independence stays required)

| | Oracle Always Free | Google Cloud Free Tier |
|--|--------------------|-------------------------|
| Compute (official) | Up to two `VM.Standard.E2.1.Micro` (AMD) **and/or** Ampere A1 Flex: first 1,500 OCPU-hours + 9,000 GB-hours/month ≈ **2 OCPU / 12 GB** for Always Free tenancies | 1 non-preemptible **`e2-micro`** / month in `us-west1`, `us-central1`, or `us-east1`; 30 GB-months standard PD |
| RAM vs Chromium | Micros are **1 GB** (poor fit). A1 **12 GB** is the plausible Always Free shape for a shared Node + occasional Chromium process | `e2-micro` is ~1 GB — headed Chromium is unlikely to be reliable |
| Idle / capacity | Idle reclaim if 7-day 95th CPU, network, **and** (A1) memory all &lt; 20%. Docs also warn **out of host capacity** | Free Trial `$300 / 90 days` is **not** Always Free. Card required at signup. Trial account auto-closes without upgrade |
| Egress (official) | Always Free includes **10 TB/month outbound** | Compute Engine Free Tier: **1 GB/month** outbound from North America (excl. China/Australia) |
| Unattended 10-min poll | Cron/systemd possible; **not demonstrated**. DIM.RIA free API quota (~30/hour, 1000/month) still cannot hydrate every listing every 10 minutes | Same quota issue; 144 Chromium navigations/day will likely blow 1 GB egress |

Trial credits ≠ permanent zero-cost. Free compute ≠ a proven free **complete** deployment.

## Implication

Hosted autonomous zero-cost execution is **not demonstrated**. The smallest *evidence* step (not approved here) is: run existing `npm run live:olx` ordinary HTTP from one Always Free A1 12 GB host or any host the operator already has. If still 403, record it; do not add stealth/proxies.
