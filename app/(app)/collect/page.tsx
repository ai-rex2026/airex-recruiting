import { getSessionProfile } from "@/lib/supabase/server";
import { ingestCollection } from "@/app/actions";
import { Card, Empty, btnAccent, inputCls, labelCls } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function CollectPage({
  searchParams,
}: {
  searchParams: Promise<{ campaign?: string; keyword?: string }>;
}) {
  const sp = await searchParams;
  const { sb } = await getSessionProfile();

  const { data: campaigns } = await sb
    .from("campaigns")
    .select("id, name")
    .order("created_at", { ascending: false });
  const campaignId = sp.campaign ?? campaigns?.[0]?.id ?? "";
  const { data: keywords } = campaignId
    ? await sb.from("keywords").select("id, keyword").eq("campaign_id", campaignId).order("created_at")
    : { data: [] };

  const { data: recent } = await sb
    .from("serp_snapshots")
    .select("id, collected_at, keyword:keywords(keyword), entries:serp_entries(id)")
    .order("collected_at", { ascending: false })
    .limit(10);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-bold text-[#1B2A4A]">収集（業務①）</h1>
        <p className="mt-1 text-xs text-slate-500">
          検索結果を貼り付けると、AIがランキング／比較記事かを判定し、掲載状況・競合・ASP区分まで整理して陣取り表を作ります。
        </p>
      </header>

      <Card
        title="検索結果を貼り付け"
        desc="1行1件。順位・タイトル・URL が混在していても構いません（URL だけでも可）。最大60行。"
      >
        {(campaigns ?? []).length === 0 ? (
          <Empty>先に案件を登録してください。</Empty>
        ) : (
          <form action={ingestCollection} className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className={labelCls}>案件</label>
                <select name="campaign_id" defaultValue={campaignId} className={inputCls}>
                  {(campaigns ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] text-slate-400">
                  案件を切り替えたい場合は、案件詳細ページの「収集を実行」から入り直してください。
                </p>
              </div>
              <div>
                <label className={labelCls}>キーワード</label>
                <select name="keyword_id" defaultValue={sp.keyword ?? ""} className={inputCls}>
                  {(keywords ?? []).map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.keyword}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className={labelCls}>貼り付け</label>
              <textarea
                name="pasted"
                rows={12}
                required
                className={`${inputCls} font-mono text-xs`}
                placeholder={`1\t【2026年最新】〇〇おすすめ10選\thttps://example-media.jp/osusume\n2\t〇〇比較ランキング\thttps://hikaku-site.com/ranking\nhttps://another-media.co.jp/matome`}
              />
            </div>
            <div className="flex items-center gap-3">
              <button className={btnAccent}>AIで解析して陣取り表に反映</button>
              <span className="text-[11px] text-slate-400">
                解析には数十秒かかることがあります。
              </span>
            </div>
          </form>
        )}
      </Card>

      <Card title="直近の収集" desc="スナップショットは時系列で保持され、順位変動の追跡に使われます">
        {(recent ?? []).length === 0 ? (
          <Empty>まだ収集履歴がありません。</Empty>
        ) : (
          <table className="tbl w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] text-slate-500">
                <th className="pb-2">キーワード</th>
                <th className="pb-2 text-right">取得件数</th>
                <th className="pb-2">取得日時</th>
              </tr>
            </thead>
            <tbody>
              {(recent ?? []).map((s) => (
                <tr key={s.id}>
                  <td className="py-2">
                    {(s.keyword as unknown as { keyword: string } | null)?.keyword ?? "—"}
                  </td>
                  <td className="py-2 text-right">
                    {(s.entries as unknown as unknown[])?.length ?? 0}
                  </td>
                  <td className="py-2 text-slate-600">
                    {new Date(s.collected_at).toLocaleString("ja-JP")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="SERP取得APIについて">
        <p className="text-xs leading-relaxed text-slate-600">
          現在は「検索結果を人が貼り付ける」入力のみに対応しています。検索エンジンの結果ページを直接スクレイピングする方式は
          利用規約およびブロックのリスクがあるため、商用の SERP 取得 API を利用する方式を推奨します（要件定義書 O-1）。
          API を選定して鍵を設定すれば、この画面の入力を自動化に置き換えられる構造にしてあります。
        </p>
      </Card>
    </div>
  );
}
