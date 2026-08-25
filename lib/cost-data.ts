import type { createClient } from "@/lib/supabase/server";
import { USAGE_KIND_LABEL, type UsageKind } from "@/lib/ai-cost";

type Sb = Awaited<ReturnType<typeof createClient>>;

export type CostByKind = {
  kind: string;
  label: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  webSearches: number;
  costUsd: number;
};

export type CampaignCost = {
  totalUsd: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  byKind: CostByKind[];
  byKeyword: { keyword: string; calls: number; costUsd: number }[];
  lastAt: string | null;
};

const n = (v: unknown) => Number(v ?? 0);

/** 案件1件ぶんのAI利用料。集計はビュー側で済ませている */
export async function loadCampaignCost(sb: Sb, campaignId: string): Promise<CampaignCost> {
  const [{ data: kinds }, { data: kws }] = await Promise.all([
    sb
      .from("ai_usage_by_kind")
      .select("kind, calls, input_tokens, output_tokens, web_searches, cost_usd, last_at")
      .eq("campaign_id", campaignId),
    sb
      .from("ai_usage_by_keyword")
      .select("keyword, calls, cost_usd")
      .eq("campaign_id", campaignId)
      .order("cost_usd", { ascending: false })
      .limit(10),
  ]);

  const byKind: CostByKind[] = (kinds ?? [])
    .map((r) => ({
      kind: String(r.kind),
      label: USAGE_KIND_LABEL[r.kind as UsageKind] ?? String(r.kind),
      calls: n(r.calls),
      inputTokens: n(r.input_tokens),
      outputTokens: n(r.output_tokens),
      webSearches: n(r.web_searches),
      costUsd: n(r.cost_usd),
    }))
    .sort((a, b) => b.costUsd - a.costUsd);

  return {
    totalUsd: byKind.reduce((a, b) => a + b.costUsd, 0),
    calls: byKind.reduce((a, b) => a + b.calls, 0),
    inputTokens: byKind.reduce((a, b) => a + b.inputTokens, 0),
    outputTokens: byKind.reduce((a, b) => a + b.outputTokens, 0),
    byKind,
    byKeyword: (kws ?? []).map((r) => ({
      keyword: String(r.keyword),
      calls: n(r.calls),
      costUsd: n(r.cost_usd),
    })),
    lastAt:
      (kinds ?? [])
        .map((r) => r.last_at as string | null)
        .filter(Boolean)
        .sort()
        .at(-1) ?? null,
  };
}

/** 案件一覧（/start のカード）用に、案件ごとの合計だけまとめて引く */
export async function loadCampaignCostTotals(sb: Sb): Promise<Map<string, number>> {
  const { data } = await sb.from("ai_usage_by_kind").select("campaign_id, cost_usd");
  const m = new Map<string, number>();
  for (const r of data ?? []) {
    const id = r.campaign_id as string | null;
    if (!id) continue;
    m.set(id, (m.get(id) ?? 0) + n(r.cost_usd));
  }
  return m;
}
