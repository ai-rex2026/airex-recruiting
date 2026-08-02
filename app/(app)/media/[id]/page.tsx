import Link from "next/link";
import { notFound } from "next/navigation";
import { getSessionProfile } from "@/lib/supabase/server";
import {
  updateMedia,
  toggleNoSolicitation,
  addContact,
  deleteContact,
  mergeMedia,
  suggestContactFix,
} from "@/app/actions";
import { Card, Badge, Empty, btnAccent, btnGhost, btnSmall, inputCls, labelCls } from "@/components/ui";
import { OUTREACH_STATUS, SEND_RESULT, statusTone } from "@/lib/domain";

export const dynamic = "force-dynamic";

export default async function MediaDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { sb, profile } = await getSessionProfile();

  const { data: m } = await sb.from("media").select("*").eq("id", id).maybeSingle();
  if (!m) notFound();

  const [{ data: contacts }, { data: targets }, { data: others }] = await Promise.all([
    sb.from("media_contacts").select("*").eq("media_id", id).order("created_at"),
    sb
      .from("outreach_targets")
      .select("*, campaign:campaigns(name), attempts:send_attempts(result, sent_at, queued_at), replies:replies(final_class, received_at)")
      .eq("media_id", id)
      .order("created_at", { ascending: false }),
    sb.from("media").select("id, domain, name").neq("id", id).limit(200),
  ]);

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs text-slate-500">
            <Link href="/media" className="hover:underline">
              メディア台帳
            </Link>
          </p>
          <h1 className="mt-1 text-xl font-bold text-[#1B2A4A]">{m.name || m.domain}</h1>
          <a
            href={`https://${m.domain}`}
            target="_blank"
            rel="noreferrer"
            className="text-xs text-sky-700 underline"
          >
            {m.domain}
          </a>
        </div>
        <div>
          {m.no_solicitation ? (
            <form action={toggleNoSolicitation} className="flex items-center gap-2">
              <input type="hidden" name="id" value={id} />
              <input type="hidden" name="to" value="false" />
              <Badge tone="bg-red-100 text-red-700">営業お断り</Badge>
              <button className={btnSmall} disabled={profile?.role !== "admin"}>
                解除（管理者のみ）
              </button>
            </form>
          ) : (
            <form action={toggleNoSolicitation} className="flex items-center gap-2">
              <input type="hidden" name="id" value={id} />
              <input type="hidden" name="to" value="true" />
              <input name="reason" placeholder="理由" className={`${inputCls} w-40`} />
              <button className={btnGhost}>営業お断りにする</button>
            </form>
          )}
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="基本情報">
          <form action={updateMedia} className="space-y-3">
            <input type="hidden" name="id" value={id} />
            <div className="grid gap-3 md:grid-cols-2">
              <div>
                <label className={labelCls}>メディア名</label>
                <input name="name" defaultValue={m.name} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>運営者</label>
                <input name="operator" defaultValue={m.operator} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>カテゴリ</label>
                <input name="category" defaultValue={m.category} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>取引ルート</label>
                <select name="asp_type" defaultValue={m.asp_type} className={inputCls}>
                  <option value="direct">直接</option>
                  <option value="asp">ASP経由</option>
                  <option value="unknown">未判定</option>
                </select>
              </div>
              <div className="md:col-span-2">
                <label className={labelCls}>ASP名</label>
                <input name="asp_name" defaultValue={m.asp_name} className={inputCls} />
              </div>
              <div className="md:col-span-2">
                <label className={labelCls}>メモ</label>
                <textarea name="note" defaultValue={m.note} rows={4} className={inputCls} />
              </div>
            </div>
            <button className={btnAccent}>保存</button>
          </form>
        </Card>

        <Card title="連絡先" desc="フォーム／メール／DM。死URLはここを直します">
          <ul className="space-y-2">
            {(contacts ?? []).map((c) => (
              <li key={c.id} className="flex items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2">
                <div className="min-w-0">
                  <Badge>{c.kind === "mail" ? "メール" : c.kind === "dm" ? "DM" : "フォーム"}</Badge>
                  <div className="break-all text-xs text-slate-700">{c.value}</div>
                </div>
                <form action={deleteContact}>
                  <input type="hidden" name="id" value={c.id} />
                  <input type="hidden" name="media_id" value={id} />
                  <button className={btnSmall}>削除</button>
                </form>
              </li>
            ))}
            {(contacts ?? []).length === 0 && <Empty>連絡先が未登録です。</Empty>}
          </ul>
          <form action={addContact} className="mt-3 flex gap-2">
            <input type="hidden" name="media_id" value={id} />
            <select name="kind" className={`${inputCls} w-28`}>
              <option value="form">フォーム</option>
              <option value="mail">メール</option>
              <option value="dm">DM</option>
            </select>
            <input name="value" placeholder="URL または メールアドレス" className={inputCls} required />
            <button className={btnGhost}>追加</button>
          </form>
          <form action={suggestContactFix} className="mt-2">
            <input type="hidden" name="media_id" value={id} />
            <button className={btnSmall}>AIに問い合わせURL候補を出させる（未検証・要確認）</button>
          </form>
        </Card>
      </div>

      <Card title="接触履歴" desc="案件をまたいだ全履歴">
        {(targets ?? []).length === 0 ? (
          <Empty>まだ打診がありません。</Empty>
        ) : (
          <table className="tbl w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] text-slate-500">
                <th className="pb-2">案件</th>
                <th className="pb-2">打診種別</th>
                <th className="pb-2">状態</th>
                <th className="pb-2">送信結果</th>
                <th className="pb-2">返信</th>
              </tr>
            </thead>
            <tbody>
              {(targets ?? []).map((t) => {
                const att = (t.attempts as unknown as { result: string; sent_at: string; queued_at: string }[]) ?? [];
                const rep = (t.replies as unknown as { final_class: string }[]) ?? [];
                return (
                  <tr key={t.id}>
                    <td className="py-2">{(t.campaign as unknown as { name: string } | null)?.name}</td>
                    <td className="py-2 text-xs">{t.kind === "replace" ? "リプレイス" : "新規"}</td>
                    <td className="py-2">
                      <Badge tone={statusTone(t.status)}>
                        {OUTREACH_STATUS[t.status as keyof typeof OUTREACH_STATUS] ?? t.status}
                      </Badge>
                    </td>
                    <td className="py-2 text-xs text-slate-600">
                      {att.length === 0
                        ? "—"
                        : att
                            .map(
                              (a) =>
                                `${new Date(a.sent_at || a.queued_at).toLocaleDateString("ja-JP")} ${
                                  SEND_RESULT[a.result as keyof typeof SEND_RESULT] ?? a.result
                                }`
                            )
                            .join(" / ")}
                    </td>
                    <td className="py-2 text-xs text-slate-600">{rep.length ? `${rep.length}件` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="名寄せ（統合）" desc="このメディアを別レコードに統合します。統合元は削除されます">
        <form action={mergeMedia} className="flex flex-wrap items-end gap-2">
          <input type="hidden" name="from_id" value={id} />
          <div className="min-w-64 flex-1">
            <label className={labelCls}>統合先</label>
            <select name="into_id" className={inputCls} required>
              <option value="">— 選択 —</option>
              {(others ?? []).map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name || o.domain}（{o.domain}）
                </option>
              ))}
            </select>
          </div>
          <button className={btnGhost}>このメディアを統合する</button>
        </form>
      </Card>
    </div>
  );
}
