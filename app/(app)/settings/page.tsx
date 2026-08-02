import { getSessionProfile } from "@/lib/supabase/server";
import { addAsp, deleteAsp, saveTenantSettings, saveProfile } from "@/app/actions";
import { Card, Empty, btnAccent, btnSmall, inputCls, labelCls } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { sb, profile, user } = await getSessionProfile();
  const { data: tenant } = await sb.from("tenants").select("*").eq("id", profile!.tenant_id).maybeSingle();
  const { data: asps } = await sb.from("asp_master").select("*").order("domain");
  const { data: members } = await sb.from("profiles").select("*").order("created_at");

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-bold text-[#1B2A4A]">設定</h1>
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="自分の情報" desc="差出人名義と署名は、AIが生成する文面に差し込まれます">
          <form action={saveProfile} className="space-y-3">
            <div>
              <label className={labelCls}>メールアドレス</label>
              <input value={user?.email ?? ""} disabled className={`${inputCls} bg-slate-50`} />
            </div>
            <div>
              <label className={labelCls}>氏名</label>
              <input name="full_name" defaultValue={profile!.full_name} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>差出人名義</label>
              <input name="sender_name" defaultValue={profile!.sender_name} className={inputCls} placeholder="例：アドレクス 渡辺" />
            </div>
            <div>
              <label className={labelCls}>署名</label>
              <textarea name="signature" defaultValue={profile!.signature} rows={5} className={inputCls} />
            </div>
            <button className={btnAccent}>保存</button>
          </form>
        </Card>

        <Card title="送信の方針" desc="要件定義書 3.3。既定は「人の承認送信」です">
          <form action={saveTenantSettings} className="space-y-3">
            <div>
              <label className={labelCls}>送信モード</label>
              <select name="send_mode" defaultValue={tenant?.send_mode ?? "approval"} className={inputCls}>
                <option value="approval">人の承認送信（推奨）</option>
                <option value="auto">自動送信（承認をスキップ）</option>
              </select>
              <p className="mt-1 text-[11px] text-slate-500">
                自動送信にしても、営業お断りの検知・CAPTCHA・二重送信防止は無効化されません。
              </p>
            </div>
            <div>
              <label className={labelCls}>送信レート上限（件／時）</label>
              <input
                name="rate_limit_per_hour"
                type="number"
                min={1}
                defaultValue={tenant?.rate_limit_per_hour ?? 30}
                className={inputCls}
              />
              <p className="mt-1 text-[11px] text-slate-500">
                送信元ドメインのレピュテーション保護のため、ワーカー側がこの値を上限として実行します。
              </p>
            </div>
            <button className={btnAccent}>保存</button>
          </form>
        </Card>
      </div>

      <Card title="ASPマスタ" desc="ドメインを ASP 経由／直接に振り分けるための対応表">
        <ul className="mb-3 space-y-1">
          {(asps ?? []).map((a) => (
            <li key={a.id} className="flex items-center gap-2 rounded bg-slate-50 px-3 py-1.5 text-sm">
              <span className="font-mono text-xs">{a.domain}</span>
              <span className="text-slate-600">{a.asp_name}</span>
              <form action={deleteAsp} className="ml-auto">
                <input type="hidden" name="id" value={a.id} />
                <button className={btnSmall}>削除</button>
              </form>
            </li>
          ))}
          {(asps ?? []).length === 0 && <Empty>まだ登録がありません。</Empty>}
        </ul>
        <form action={addAsp} className="flex gap-2">
          <input name="domain" placeholder="example.com" className={inputCls} required />
          <input name="asp_name" placeholder="ASP名" className={inputCls} />
          <button className={btnAccent}>追加</button>
        </form>
      </Card>

      <Card title="メンバー" desc="ロールの変更は現在 Supabase 側で行います">
        <table className="grid w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] text-slate-500">
              <th className="pb-2">氏名</th>
              <th className="pb-2">差出人名義</th>
              <th className="pb-2">ロール</th>
            </tr>
          </thead>
          <tbody>
            {(members ?? []).map((m) => (
              <tr key={m.id}>
                <td className="py-2">{m.full_name || "—"}</td>
                <td className="py-2 text-slate-600">{m.sender_name || "—"}</td>
                <td className="py-2 text-slate-600">{m.role}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card title="ワーカー連携">
        <p className="text-xs leading-relaxed text-slate-600">
          外部の送信ワーカー（form-outreach-runner）は、環境変数 <code className="rounded bg-slate-100 px-1">WORKER_TOKEN</code> を
          <code className="mx-1 rounded bg-slate-100 px-1">x-worker-token</code> ヘッダに付けて
          <code className="mx-1 rounded bg-slate-100 px-1">/api/worker/pull</code> を叩き、結果を
          <code className="mx-1 rounded bg-slate-100 px-1">/api/worker/report</code> に返します。
          トークンが未設定の場合、これらの API は 503 を返します。
        </p>
      </Card>
    </div>
  );
}
