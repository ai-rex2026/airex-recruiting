import Link from "next/link";
import { notFound } from "next/navigation";
import { getSessionProfile } from "@/lib/supabase/server";
import { addKeywords, deleteKeyword, suggestKeywords } from "@/app/actions";
import { Card, Empty, btnAccent, btnGhost, btnSmall, inputCls, labelCls } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function CampaignDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { sb } = await getSessionProfile();

  const { data: c } = await sb
    .from("campaigns")
    .select("*, client:clients(name)")
    .eq("id", id)
    .maybeSingle();
  if (!c) notFound();

  const { data: kws } = await sb
    .from("keywords")
    .select("*, snapshots:serp_snapshots(id, collected_at)")
    .eq("campaign_id", id)
    .order("created_at");

  const { data: targets } = await sb
    .from("outreach_targets")
    .select("status")
    .eq("campaign_id", id);

  const cnt = (s: string) => (targets ?? []).filter((t) => t.status === s).length;

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs text-slate-500">
            <Link href="/campaigns" className="hover:underline">
              案件一覧
            </Link>{" "}
            /{" "}
            {(c.client as unknown as { name: string } | null)?.name ?? "クライアント未設定"}
          </p>
          <h1 className="mt-1 text-xl font-bold text-[#1B2A4A]">{c.name}</h1>
        </div>
        <div className="flex gap-2">
          <Link href={`/collect?campaign=${id}`} className={btnAccent}>
            収集を実行
          </Link>
          <Link href={`/board?campaign=${id}`} className={btnGhost}>
            陣取りボード
          </Link>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="案件情報">
          <dl className="space-y-2 text-sm">
            {[
              ["商材", c.product_name],
              ["LP", c.lp_url],
              ["単価", c.unit_price],
              ["成果地点", c.conversion_point],
              ["承認条件", c.approval_terms],
              ["訴求・信用点", c.selling_points],
            ].map(([k, v]) => (
              <div key={k as string}>
                <dt className="text-[11px] text-slate-500">{k}</dt>
                <dd className="break-all text-slate-800">{(v as string) || "—"}</dd>
              </div>
            ))}
          </dl>
        </Card>

        <Card title="この案件の進捗">
          <div className="grid grid-cols-2 gap-2 text-sm">
            {[
              ["収集済", "collected"],
              ["対象確定", "confirmed"],
              ["承認待ち", "awaiting_approval"],
              ["送信済", "sent"],
              ["返信あり", "replied"],
              ["掲載中", "placed"],
            ].map(([label, key]) => (
              <div key={key} className="rounded-lg bg-slate-50 px-3 py-2">
                <div className="text-[11px] text-slate-500">{label}</div>
                <div className="text-lg font-bold text-[#1B2A4A]">{cnt(key)}</div>
              </div>
            ))}
          </div>
        </Card>

        <Card title="キーワードを追加">
          <form action={addKeywords} className="space-y-3">
            <input type="hidden" name="campaign_id" value={id} />
            <textarea
              name="keywords"
              rows={5}
              className={inputCls}
              placeholder={"改行または読点で区切って入力"}
            />
            <button className={btnAccent}>追加</button>
          </form>
          <form action={suggestKeywords} className="mt-3">
            <input type="hidden" name="campaign_id" value={id} />
            <button className={btnGhost}>AIにKWを提案させる</button>
          </form>
        </Card>
      </div>

      <Card title="キーワード一覧" desc="収集の実行単位。定点観測の履歴もここに紐づきます">
        {(kws ?? []).length === 0 ? (
          <Empty>キーワードが未登録です。</Empty>
        ) : (
          <table className="grid w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] text-slate-500">
                <th className="pb-2">キーワード</th>
                <th className="pb-2 text-right">収集回数</th>
                <th className="pb-2">最終収集</th>
                <th className="pb-2"></th>
              </tr>
            </thead>
            <tbody>
              {(kws ?? []).map((k) => {
                const snaps = (k.snapshots as unknown as { collected_at: string }[]) ?? [];
                const last = snaps
                  .map((s) => s.collected_at)
                  .sort()
                  .at(-1);
                return (
                  <tr key={k.id}>
                    <td className="py-2 font-medium">{k.keyword}</td>
                    <td className="py-2 text-right">{snaps.length}</td>
                    <td className="py-2 text-slate-600">
                      {last ? new Date(last).toLocaleString("ja-JP") : "未収集"}
                    </td>
                    <td className="py-2 text-right">
                      <Link href={`/collect?campaign=${id}&keyword=${k.id}`} className={btnSmall}>
                        収集
                      </Link>{" "}
                      <form action={deleteKeyword} className="inline">
                        <input type="hidden" name="id" value={k.id} />
                        <input type="hidden" name="campaign_id" value={id} />
                        <button className={btnSmall}>削除</button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
