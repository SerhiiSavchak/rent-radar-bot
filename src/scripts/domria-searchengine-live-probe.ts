async function main(): Promise<void> {
  const results = [];
  for (let i = 1; i <= 3; i += 1) {
    const url =
      "https://dom.ria.com/node/searchEngine/v2/?" +
      new URLSearchParams({
        addMoreRealty: "false",
        excludeSold: "1",
        category: "1",
        realty_type: "2",
        operation: "3",
        state_id: "5",
        in_radius: "0",
        with_newbuilds: "0",
        price_cur: "1",
        wo_dupl: "1",
        complex_inspected: "0",
        sort: "created_at",
        period: "0",
        notFirstFloor: "0",
        notLastFloor: "0",
        with_map: "0",
        photos_count_from: "0",
        with_video_only: "0",
        firstIteraction: "false",
        fromAmp: "0",
        page: "0",
        limit: "20",
        city_ids: "5",
        operation_type: "3",
        client: "searchV2",
        ch: "246_244",
        mobileStatus: "0",
      }).toString();
    const r = await fetch(url, {
      headers: { Accept: "application/json", "user-agent": "Mozilla/5.0" },
    });
    const t = await r.text();
    let items: number | string = "n/a";
    let reason = "ok";
    try {
      const j = JSON.parse(t) as { items?: unknown };
      items = Array.isArray(j.items) ? j.items.length : "missing";
    } catch {
      reason = "parse_fail";
    }
    results.push({ i, status: r.status, items, reason });
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  console.log(JSON.stringify(results));
}

void main();
