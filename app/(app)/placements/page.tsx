import Link from "next/link";
import { getSessionProfile } from "@/lib/supabase/server";
import { createPlacement, markReported } from "@/app/actions";
import { Card, Empty, Badge, btnGhost, inputCls, labelCls } from "@/components/ui";
import SubmitButton from "@/components/SubmitButton";

export const dynamic = "force-dynamic";

export default async function PlacementsPage() {
  const { sb } = await getSessionProfile();

  const { data: campaigns } = await sb.from("campaigns").select("id, name").order("created_at", { ascending: false });

  const { data: placeable } = await sb
    .from("outreach_targets")
    .select("id, article_url, media:media(name, domain), campaign:campaigns(name)")
    .eq("status", "placeable")
    .limit(100);

  const { data: placements } = await sb
    .from("placements")
    .select("*, target:outreach_targets(status, media:media(id, name, domain), campaign:campaigns(id, name))")
    .order("created_at", { ascending: false })
    .limit(200);

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-bold text-[#1B2A4A]">掲載・報告</h1>
        <p className="mt-1 text-xs text-slate-500">
          掲載成立を登録し、クライアント向けの掲載完了報告を作ります。
        </p>
      </header>

      <Card title="掲載を登録" desc="「掲載可能」になった打診から選びます">
        {(placeable ?? []).length === 0 ? (
          <Empty>掲載可能の打診がありません。</Empty>
        ) : (
          <form action={createPlacement} className="grid gap-3 md:grid-cols-3">
            <div className="md:col-span-3">
              <label className={labelCls}>打診先</label>
              <select name="target_id" required className={inputCls}>
                <option value="">— 選択 —</option>
                {(placeable ?? []).map((t) => {
                  const m = t.media as unknown as { name: string; domain: string };
                  const c = t.campaign as unknown as { name: string };
                  return (
                    <option key={t.id} value={t.id}>
                      {m?.name || m?.domain} / {c?.name}
                    </option>
                  );
                })}
              </select>
            </div>
            <div className="md:col-span-2">
              <label className={labelCls}>掲載記事URL</label>
              <input name="article_url" className={inputCls} placeholder="https://" />
            </div>
            <div>
              <label className={labelCls}>記事内の掲載順位</label>
              <input name="position" type="number" min={1} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>単価</label>
              <input name="unit_price" className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>掲載開始日</label>
              <input name="started_on" type="date" className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>証跡（スクリーンショットURL等）</label>
              <input name="evidence_path" className={inputCls} />
            </div>
            <div className="md:col-span-3">
              <SubmitButton variant="accent">掲載を登録</SubmitButton>
            </div>
          </form>
        )}
      </Card>

      <Card title="掲載一覧">
        {(placements ?? []).length === 0 ? (
          <Empty>まだ掲載がありません。</Empty>
        ) : (
          <table className="tbl w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] text-slate-500">
                <th className="pb-2">メディア</th>
                <th className="pb-2">案件</th>
                <th className="pb-2 text-right">記事内順位</th>
                <th className="pb-2">単価</th>
                <th className="pb-2">開始日</th>
                <th className="pb-2">状態</th>
              </tr>
            </thead>
            <tbody>
              {(placements ?? []).map((p) => {
                const t = p.target as unknown as {
                  status: string;
                  media?: { id: string; name: string; domain: string };
                  campaign?: { id: string; name: string };
                } | null;
                return (
                  <tr key={p.id}>
                    <td className="py-2">
                      <Link href={`/media/${t?.media?.id}`} className="hover:underline">
                        {t?.media?.name || t?.media?.domain}
                      </Link>
                      {p.article_url && (
                        <div>
                          <a
                            href={p.article_url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[11px] text-sky-700 underline"
                          >
                            記事
                          </a>
                        </div>
                      )}
                    </td>
                    <td className="py-2 text-slate-600">{t?.campaign?.name}</td>
                    <td className="py-2 text-right">{p.position_in_article ?? "—"}</td>
                    <td className="py-2">{p.unit_price || "—"}</td>
                    <td className="py-2 text-[11px] text-slate-500">{p.started_on ?? "—"}</td>
                    <td className="py-2">
                      <Badge
                        tone={
                          t?.status === "reported"
                            ? "bg-emerald-100 text-emerald-800"
                            : "bg-sky-100 text-sky-800"
                        }
                      >
                        {t?.status === "reported" ? "報告済" : "掲載中"}
                      </Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="掲載完了報告" desc="案件ごとに、掲載メディア一覧・順位・証跡を含む報告書を出力します">
        <div className="space-y-2">
          {(campaigns ?? []).map((c) => (
            <div key={c.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2">
              <span className="text-sm font-medium">{c.name}</span>
              <Link href={`/reports/${c.id}`} target="_blank" className={`${btnGhost} ml-auto`}>
                報告書を開く（印刷・PDF保存可）
              </Link>
              <form action={markReported}>
                <input type="hidden" name="campaign_id" value={c.id} />
                <SubmitButton variant="ghost">報告済みにする</SubmitButton>
              </form>
            </div>
          ))}
          {(campaigns ?? []).length === 0 && <Empty>案件がありません。</Empty>}
        </div>
      </Card>
    </div>
  );
}
