import Link from "next/link";
import { getSessionProfile } from "@/lib/supabase/server";
import { Card, Empty, Badge } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function MediaPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const sp = await searchParams;
  const q = (sp.q ?? "").trim();
  const { sb } = await getSessionProfile();

  let query = sb
    .from("media")
    .select("*, contacts:media_contacts(id), targets:outreach_targets(id, status)")
    .order("created_at", { ascending: false })
    .limit(300);
  if (q) query = query.or(`domain.ilike.%${q}%,name.ilike.%${q}%`);
  const { data: media } = await query;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-bold text-[#1B2A4A]">メディア台帳</h1>
        <p className="mt-1 text-xs text-slate-500">
          案件をまたいで共有される、このアプリで最も価値の高いデータ。接触履歴・返信率・営業お断りがここに溜まります。
        </p>
      </header>

      <Card>
        <form className="flex gap-2">
          <input
            name="q"
            defaultValue={q}
            placeholder="ドメイン・メディア名で検索"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
          />
          <button className="whitespace-nowrap rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm">検索</button>
        </form>
      </Card>

      <Card title={`登録メディア（${(media ?? []).length}件）`}>
        {(media ?? []).length === 0 ? (
          <Empty>まだメディアがありません。収集を実行すると自動で登録されます。</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] text-slate-500">
                  <th className="pb-2">メディア</th>
                  <th className="pb-2">区分</th>
                  <th className="pb-2 text-right">連絡先</th>
                  <th className="pb-2 text-right">打診</th>
                  <th className="pb-2 text-right">掲載</th>
                  <th className="pb-2 text-right">返信率</th>
                  <th className="pb-2">状態</th>
                </tr>
              </thead>
              <tbody>
                {(media ?? []).map((m) => {
                  const ts = (m.targets as unknown as { status: string }[]) ?? [];
                  const sent = ts.filter((t) =>
                    ["sent", "replied", "negotiating", "placeable", "placed", "reported", "rejected"].includes(t.status)
                  ).length;
                  const replied = ts.filter((t) =>
                    ["replied", "negotiating", "placeable", "placed", "reported", "rejected"].includes(t.status)
                  ).length;
                  const placed = ts.filter((t) => ["placed", "reported"].includes(t.status)).length;
                  return (
                    <tr key={m.id}>
                      <td className="py-2">
                        <Link href={`/media/${m.id}`} className="font-medium hover:underline">
                          {m.name || m.domain}
                        </Link>
                        <div className="text-[11px] text-slate-400">{m.domain}</div>
                      </td>
                      <td className="py-2 text-xs text-slate-600">
                        {m.asp_type === "asp" ? `ASP経由${m.asp_name ? `（${m.asp_name}）` : ""}` : m.asp_type === "direct" ? "直接" : "未判定"}
                      </td>
                      <td className="py-2 text-right">
                        {((m.contacts as unknown as unknown[]) ?? []).length}
                      </td>
                      <td className="py-2 text-right">{ts.length}</td>
                      <td className="py-2 text-right font-semibold">{placed}</td>
                      <td className="py-2 text-right">
                        {sent ? `${Math.round((replied / sent) * 100)}%` : "—"}
                      </td>
                      <td className="py-2">
                        {m.no_solicitation ? (
                          <Badge tone="bg-red-100 text-red-700">営業お断り</Badge>
                        ) : (
                          <Badge tone="bg-emerald-100 text-emerald-800">打診可</Badge>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
