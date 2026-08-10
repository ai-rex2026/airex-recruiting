import Link from "next/link";
import { getSessionProfile } from "@/lib/supabase/server";
import { recordSendResult } from "@/app/actions";
import { Card, Empty, Badge, inputCls } from "@/components/ui";
import { SEND_RESULT } from "@/lib/domain";
import SubmitButton from "@/components/SubmitButton";

/**
 * 送信ログの本体（サーバーコンポーネント）。
 * /outbox（旧ルート）と /queue?tab=outbox の両方から使う。
 */
export default async function OutboxView() {
  const { sb, profile } = await getSessionProfile();

  const { data: tenant } = await sb
    .from("tenants")
    .select("*")
    .eq("id", profile?.tenant_id ?? "")
    .maybeSingle();

  const { data: attempts } = await sb
    .from("send_attempts")
    .select(
      "*, target:outreach_targets(id, article_url, media:media(id, name, domain), campaign:campaigns(name)), contact:media_contacts(kind, value)"
    )
    .order("queued_at", { ascending: false })
    .limit(200);

  const queued = (attempts ?? []).filter((a) => a.result === "queued");
  const done = (attempts ?? []).filter((a) => a.result !== "queued");

  const line = (a: Record<string, unknown>) => {
    const t = a.target as { media?: { id: string; name: string; domain: string }; campaign?: { name: string } } | null;
    const c = a.contact as { kind: string; value: string } | null;
    return { t, c };
  };

  return (
    <div className="space-y-6">
      <Card title="送信ワーカー連携" desc="このアプリは承認と記録を担当し、送信そのものは別プロセスが行います">
        <div className="space-y-2 text-xs leading-relaxed text-slate-600">
          <p>
            承認された件は下の「送信キュー」に入ります。外部の Playwright ワーカーは次の API を叩いて取得・報告します。
          </p>
          <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3 text-[11px] text-slate-100">
{`GET  /api/worker/pull      Header: x-worker-token: <WORKER_TOKEN>
POST /api/worker/report    Body: {"attempt_id":"...","result":"success|uncertain|form_error|url_error|captcha|no_solicitation","detail":"..."}`}
          </pre>
          <p>
            現在の送信モード：
            <b className="ml-1">{tenant?.send_mode === "auto" ? "自動送信" : "人の承認送信"}</b>
            ／ レート上限 {tenant?.rate_limit_per_hour ?? 30} 件/時（
            <Link href="/settings" className="underline">
              設定
            </Link>
            ）
          </p>
        </div>
      </Card>

      <Card title={`送信キュー（${queued.length}件）`} desc="ワーカーの実行待ち。手動で送った場合はここで結果を記録します">
        {queued.length === 0 ? (
          <Empty>送信待ちはありません。</Empty>
        ) : (
          <table className="tbl w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] text-slate-500">
                <th className="pb-2">メディア</th>
                <th className="pb-2">案件</th>
                <th className="pb-2">送信先</th>
                <th className="pb-2">承認日時</th>
                <th className="pb-2">結果を記録</th>
              </tr>
            </thead>
            <tbody>
              {queued.map((a) => {
                const { t, c } = line(a as unknown as Record<string, unknown>);
                return (
                  <tr key={a.id}>
                    <td className="py-2">
                      <Link href={`/media/${t?.media?.id}`} className="hover:underline">
                        {t?.media?.name || t?.media?.domain}
                      </Link>
                    </td>
                    <td className="py-2 text-slate-600">{t?.campaign?.name}</td>
                    <td className="py-2 break-all text-[11px] text-slate-500">
                      {c ? `${c.kind}：${c.value}` : "未設定"}
                    </td>
                    <td className="py-2 text-[11px] text-slate-500">
                      {new Date(a.queued_at).toLocaleString("ja-JP")}
                    </td>
                    <td className="py-2">
                      <form action={recordSendResult} className="flex gap-1">
                        <input type="hidden" name="attempt_id" value={a.id} />
                        <select name="result" className={`${inputCls} w-36 py-1 text-xs`} defaultValue="manual">
                          {Object.entries(SEND_RESULT)
                            .filter(([k]) => k !== "queued")
                            .map(([k, v]) => (
                              <option key={k} value={k}>
                                {v}
                              </option>
                            ))}
                        </select>
                        <input name="detail" placeholder="備考" className={`${inputCls} w-28 py-1 text-xs`} />
                        <SubmitButton variant="small">記録</SubmitButton>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="送信履歴">
        {done.length === 0 ? (
          <Empty>まだ送信実績がありません。</Empty>
        ) : (
          <table className="tbl w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] text-slate-500">
                <th className="pb-2">メディア</th>
                <th className="pb-2">案件</th>
                <th className="pb-2">結果</th>
                <th className="pb-2">詳細</th>
                <th className="pb-2">日時</th>
              </tr>
            </thead>
            <tbody>
              {done.map((a) => {
                const { t } = line(a as unknown as Record<string, unknown>);
                const tone =
                  a.result === "success"
                    ? "bg-emerald-100 text-emerald-800"
                    : a.result === "uncertain"
                    ? "bg-amber-100 text-amber-800"
                    : a.result === "manual"
                    ? "bg-sky-100 text-sky-800"
                    : "bg-red-100 text-red-700";
                return (
                  <tr key={a.id}>
                    <td className="py-2">{t?.media?.name || t?.media?.domain}</td>
                    <td className="py-2 text-slate-600">{t?.campaign?.name}</td>
                    <td className="py-2">
                      <Badge tone={tone}>{SEND_RESULT[a.result as keyof typeof SEND_RESULT] ?? a.result}</Badge>
                    </td>
                    <td className="py-2 text-[11px] text-slate-500">{a.error_detail || "—"}</td>
                    <td className="py-2 text-[11px] text-slate-500">
                      {new Date(a.sent_at || a.queued_at).toLocaleString("ja-JP")}
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
