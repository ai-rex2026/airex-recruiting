import Link from "next/link";
import { getSessionProfile } from "@/lib/supabase/server";
import { createCampaign, duplicateCampaign } from "@/app/actions";
import { Card, Empty, btnAccent, btnSmall, inputCls, labelCls } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function CampaignsPage() {
  const { sb } = await getSessionProfile();
  const { data: campaigns } = await sb
    .from("campaigns")
    .select("*, client:clients(name), keywords:keywords(id)")
    .order("created_at", { ascending: false });

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-bold text-[#1B2A4A]">案件・キーワード</h1>
        <p className="mt-1 text-xs text-slate-500">
          案件（商材 × 報酬条件）と、狙う検索キーワードを登録します。
        </p>
      </header>

      <Card title="案件一覧">
        {(campaigns ?? []).length === 0 ? (
          <Empty>まだ案件がありません。下のフォームから登録してください。</Empty>
        ) : (
          <table className="grid w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] text-slate-500">
                <th className="pb-2">案件名</th>
                <th className="pb-2">クライアント</th>
                <th className="pb-2">商材</th>
                <th className="pb-2 text-right">KW数</th>
                <th className="pb-2"></th>
              </tr>
            </thead>
            <tbody>
              {(campaigns ?? []).map((c) => (
                <tr key={c.id}>
                  <td className="py-2">
                    <Link href={`/campaigns/${c.id}`} className="font-medium hover:underline">
                      {c.name}
                    </Link>
                  </td>
                  <td className="py-2 text-slate-600">
                    {(c.client as unknown as { name: string } | null)?.name ?? "—"}
                  </td>
                  <td className="py-2 text-slate-600">{c.product_name || "—"}</td>
                  <td className="py-2 text-right">
                    {(c.keywords as unknown as unknown[])?.length ?? 0}
                  </td>
                  <td className="py-2 text-right">
                    <form action={duplicateCampaign} className="inline">
                      <input type="hidden" name="id" value={c.id} />
                      <button className={btnSmall}>複製</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="案件を登録" desc="現行のリクルーティングシートの項目に対応しています">
        <form action={createCampaign} className="grid gap-4 md:grid-cols-2">
          <div>
            <label className={labelCls}>案件名 *</label>
            <input name="name" required className={inputCls} placeholder="例：〇〇サービス 2026上期" />
          </div>
          <div>
            <label className={labelCls}>クライアント名</label>
            <input name="client_name" className={inputCls} placeholder="例：株式会社〇〇" />
          </div>
          <div>
            <label className={labelCls}>商材名</label>
            <input name="product_name" className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>LP URL</label>
            <input name="lp_url" className={inputCls} placeholder="https://" />
          </div>
          <div>
            <label className={labelCls}>単価（グロス／ネット）</label>
            <input name="unit_price" className={inputCls} placeholder="例：ネット 5,000円/件" />
          </div>
          <div>
            <label className={labelCls}>成果地点</label>
            <input name="conversion_point" className={inputCls} placeholder="例：無料申込完了" />
          </div>
          <div className="md:col-span-2">
            <label className={labelCls}>承認条件</label>
            <input name="approval_terms" className={inputCls} placeholder="例：重複申込・自己申込は非承認" />
          </div>
          <div className="md:col-span-2">
            <label className={labelCls}>訴求ポイント・信用点</label>
            <textarea name="selling_points" rows={2} className={inputCls} />
          </div>
          <div className="md:col-span-2">
            <label className={labelCls}>キーワード（改行または読点区切り／後から追加できます）</label>
            <textarea
              name="keywords"
              rows={4}
              className={inputCls}
              placeholder={"〇〇 おすすめ\n〇〇 比較\n〇〇 ランキング"}
            />
          </div>
          <div className="md:col-span-2">
            <button className={btnAccent}>案件を登録</button>
          </div>
        </form>
      </Card>
    </div>
  );
}
