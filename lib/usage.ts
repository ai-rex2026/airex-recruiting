import type { createClient } from "@/lib/supabase/server";
import { usdFor, type UsageKind } from "@/lib/ai-cost";
import type { AiUsage } from "@/lib/anthropic";

type SB = Awaited<ReturnType<typeof createClient>>;

/** どの案件・どのKWの、何の処理でかかったコストか */
export type UsageScope = {
  tenantId: string;
  kind: UsageKind;
  campaignId?: string | null;
  keywordId?: string | null;
};

/**
 * askJson / askText の meter に渡す関数を作る。1回の呼び出しにつき ai_usage へ1行積む。
 * 記録の失敗で本体の処理を落としたくないので、握りつぶして続行する。
 */
export function meterTo(sb: SB, scope: UsageScope) {
  return async (u: AiUsage) => {
    try {
      await sb.from("ai_usage").insert({
        tenant_id: scope.tenantId,
        campaign_id: scope.campaignId ?? null,
        keyword_id: scope.keywordId ?? null,
        kind: scope.kind,
        model: u.model,
        input_tokens: u.input_tokens,
        output_tokens: u.output_tokens,
        web_searches: u.web_searches ?? 0,
        cost_usd: usdFor(u.model, u.input_tokens, u.output_tokens, u.web_searches ?? 0),
      });
    } catch {
      // 計測は補助情報。記録できなくても処理は続ける
    }
  };
}
