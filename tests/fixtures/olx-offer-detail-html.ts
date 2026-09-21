import { derivedOracleHousePrivateAd } from "./olx-prerendered-oracle-derived.ts";

function wrapQuotedState(state: unknown): string {
  return JSON.stringify(JSON.stringify(state));
}

export function derivedOracleOfferDetailHtml(ad: unknown): string {
  const record = ad as { url?: string; id?: number };
  return `<!DOCTYPE html><html lang="uk"><head><title>OLX</title>
<link rel="canonical" href="${record.url ?? ""}">
</head><body>
<a href="${record.url ?? "/d/uk/obyavlenie/x-ID10xy7c.html"}">offer</a>
<script>window.__PRERENDERED_STATE__ = ${wrapQuotedState({ ad: { ad } })};</script>
</body></html>`;
}

export function derivedOracleOfferDetailOwnerHtml(): string {
  const ad = {
    ...derivedOracleHousePrivateAd(),
    user: {
      ...derivedOracleHousePrivateAd().user,
      sellerType: "owner",
    },
  };
  return derivedOracleOfferDetailHtml(ad);
}

export function derivedOracleOfferDetailMissingSellerHtml(): string {
  const base = derivedOracleHousePrivateAd();
  const ad = {
    ...base,
    user: { id: base.user.id, name: base.user.name, company_name: base.user.company_name },
  };
  return derivedOracleOfferDetailHtml(ad);
}

export function derivedOracleOfferDetailChallengeHtml(): string {
  return `<!DOCTYPE html><html><head><title>Just a moment...</title></head>
<body>Checking your browser before accessing olx.ua</body></html>`;
}
