import { notFound } from "next/navigation";
import { getSessionProfile } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export default async function ReportPage({
  params,
}: {
  params: Promise<{ campaignId: string }>;
}) {
  const { campaignId } = await params;
  const { sb } = await getSessionProfile();

  const { data: c } = await sb
    .from("campaigns")
    .select("*, client:clients(name)")
    .eq("id", campaignId)
    .maybeSingle();
  if (!c) notFound();

  const { data: placements } = await sb
    .from("placements")
    .select("*, target:outreach_targets(campaign_id, rank, media:media(name, domain, asp_type, asp_name))")
    .order("started_on", { ascending: true });

  const rows = (placements ?? []).filter(
    (p) => (p.target as unknown as { campaign_id: string } | null)?.campaign_id === campaignId
  );

  const today = new Date().toLocaleDateString("ja-JP");

  return (
    <main className="mx-auto max-w-4xl bg-white p-10 text-slate-900">
      <div className="no-print mb-6 rounded-lg bg-slate-100 px-4 py-2 text-xs text-slate-600">
        ブラウザの印刷機能（Ctrl/⌘ + P）から PDF として保存できます。
      </div>

      <header className="border-b-2 border-[#1B2A4A] pb-4">
        <p className="text-xs font-bold text-[#C1553B]">掲載完了報告書</p>
        <h1 className="mt-1 text-2xl font-bold text-[#1B2A4A]">{c.name}</h1>
        <p className="mt-1 text-sm text-slate-600">
          {(c.client as unknown as { name: string } | null)?.name ?? ""}　御中
        </p>
        <p className="mt-2 text-xs text-slate-500">
          商材：{c.product_name || "—"} ／ 成果地点：{c.conversion_point || "—"} ／ 作成日：{today}
        </p>
      </header>

      <section className="mt-6">
        <h2 className="mb-2 text-sm font-bold text-[#1B2A4A]">掲載サマリ</h2>
        <div className="grid grid-cols-3 gap-3">
          <div className="rounded-lg border border-slate-200 p-3">
            <div className="text-[11px] text-slate-500">掲載メディア数</div>
            <div className="text-2xl font-bold text-[#1B2A4A]">{rows.length}</div>
          </div>
          <div className="rounded-lg border border-slate-200 p-3">
            <div className="text-[11px] text-slate-500">直接取引</div>
            <div className="text-2xl font-bold text-[#1B2A4A]">
              {
                rows.filter(
                  (p) =>
                    (p.target as unknown as { media?: { asp_type: string } })?.media?.asp_type === "direct"
                ).length
              }
            </div>
          </div>
          <div className="rounded-lg border border-slate-200 p-3">
            <div className="text-[11px] text-slate-500">ASP経由</div>
            <div className="text-2xl font-bold text-[#1B2A4A]">
              {
                rows.filter(
                  (p) => (p.target as unknown as { media?: { asp_type: string } })?.media?.asp_type === "asp"
                ).length
              }
            </div>
          </div>
        </div>
      </section>

      <section className="mt-6">
        <h2 className="mb-2 text-sm font-bold text-[#1B2A4A]">掲載一覧</h2>
        {rows.length === 0 ? (
          <p className="rounded border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">
            この案件にはまだ掲載実績が登録されていません。
          </p>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-[#1B2A4A] text-left text-xs text-white">
                <th className="px-3 py-2">メディア</th>
                <th className="px-3 py-2">取引ルート</th>
                <th className="px-3 py-2 text-right">検索順位</th>
                <th className="px-3 py-2 text-right">記事内順位</th>
                <th className="px-3 py-2">単価</th>
                <th className="px-3 py-2">開始日</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p, i) => {
                const t = p.target as unknown as {
                  rank: number | null;
                  media?: { name: string; domain: string; asp_type: string; asp_name: string };
                } | null;
                return (
                  <tr key={p.id} className={i % 2 ? "bg-slate-50" : ""}>
                    <td className="px-3 py-2">
                      <div className="font-medium">{t?.media?.name || t?.media?.domain}</div>
                      <div className="text-[11px] text-slate-500">{p.article_url}</div>
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {t?.media?.asp_type === "asp"
                        ? `ASP経由${t?.media?.asp_name ? `（${t.media.asp_name}）` : ""}`
                        : "直接"}
                    </td>
                    <td className="px-3 py-2 text-right">{t?.rank ?? "—"}</td>
                    <td className="px-3 py-2 text-right">{p.position_in_article ?? "—"}</td>
                    <td className="px-3 py-2">{p.unit_price || "—"}</td>
                    <td className="px-3 py-2">{p.started_on ?? "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <footer className="mt-10 border-t border-slate-200 pt-3 text-[11px] text-slate-500">
        本報告書は AI-Rex Recruiting により自動生成されました。掲載証跡は各メディアの掲載記事URLをご確認ください。
      </footer>
    </main>
  );
}
