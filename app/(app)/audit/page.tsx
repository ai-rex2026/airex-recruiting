import { getSessionProfile } from "@/lib/supabase/server";
import { Card, Empty, Badge } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ entity?: string }>;
}) {
  const sp = await searchParams;
  const { sb } = await getSessionProfile();

  let q = sb.from("audit_logs").select("*").order("created_at", { ascending: false }).limit(500);
  if (sp.entity) q = q.eq("entity", sp.entity);
  const { data: logs } = await q;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-bold text-[#1B2A4A]">監査ログ</h1>
        <p className="mt-1 text-xs text-slate-500">
          誰がいつ何を承認・送信・編集したかを記録しています。顧客に売るときの「証跡が残る仕組み」の核です。
        </p>
      </header>

      <Card title={`直近 ${(logs ?? []).length} 件`}>
        {(logs ?? []).length === 0 ? (
          <Empty>まだ記録がありません。</Empty>
        ) : (
          <table className="tbl w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] text-slate-500">
                <th className="pb-2">日時</th>
                <th className="pb-2">実行者</th>
                <th className="pb-2">対象</th>
                <th className="pb-2">操作</th>
                <th className="pb-2">詳細</th>
              </tr>
            </thead>
            <tbody>
              {(logs ?? []).map((l) => (
                <tr key={l.id}>
                  <td className="py-2 whitespace-nowrap text-[11px] text-slate-500">
                    {new Date(l.created_at).toLocaleString("ja-JP")}
                  </td>
                  <td className="py-2">{l.actor_name || "—"}</td>
                  <td className="py-2">
                    <Badge>{l.entity}</Badge>
                  </td>
                  <td className="py-2 font-medium text-slate-700">{l.action}</td>
                  <td className="py-2 text-[11px] text-slate-500">{l.detail || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
