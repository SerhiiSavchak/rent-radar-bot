import type { Listing } from "../domain/listing.ts";

export interface ListingOutput {
  send(listing: Listing): Promise<void>;
}

function formatPrice(listing: Listing): string {
  if (!listing.price) {
    return "n/a";
  }
  return `${listing.price.amount} ${listing.price.currency}/${listing.price.period ?? "unknown"}`;
}

export class ConsoleOutput implements ListingOutput {
  async send(listing: Listing): Promise<void> {
    const lines = [
      "DATA KIND: LIVE DATA",
      `source: ${listing.source}`,
      `title: ${listing.title}`,
      `price: ${formatPrice(listing)}`,
      `location: ${listing.location.raw}`,
      `listing URL: ${listing.url}`,
      `listing ID: ${listing.sourceId}`,
      `publication date/time: ${listing.publishedAt?.toISOString() ?? "n/a"}`,
      `property type: ${listing.propertyType}`,
      `seller/owner classification: ${listing.sellerType}`,
      `filter considers private/owner: ${String(listing.metadata?.filterConsidersPrivateOwner ?? listing.sellerType === "owner")}`,
      `seller evidence: ${(listing.sellerEvidence ?? []).join(" | ") || "n/a"}`,
    ];
    console.log(lines.join("\n"));
    console.log("---");
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export class TelegramOutput implements ListingOutput {
  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly timeoutMs: number,
  ) {}

  async send(listing: Listing): Promise<void> {
    const text = [
      "🏠 <b>Нове оголошення</b>",
      "",
      escapeHtml(listing.title),
      "",
      `💰 ${escapeHtml(formatPrice(listing))}`,
      `📍 ${escapeHtml(listing.location.raw)}`,
      `👤 ${escapeHtml(listing.sellerType)}`,
      "",
      escapeHtml(listing.url),
      "",
      `Source: ${escapeHtml(listing.source)}`,
    ].join("\n");

    const response = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: this.chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: false,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Telegram send failed: ${response.status} ${body}`);
    }
  }
}
