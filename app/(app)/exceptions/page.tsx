import Link from "next/link";
import { getSessionProfile } from "@/lib/supabase/server";
import { recordSendResult, addContact, suggestContactFix, setTargetStatus } from "@/app/actions";
import { Card, Empty, Badge, btnSmall, btnGhost, inputCls } from "@/components/ui";
import { SEND_RESULT } from "@/lib/domain";

export const dynamic = "force-dynamic";

const GROUPS: { key: string; title: string; desc: string }[] = [
  { key: "captcha", title: "CAPTCHA", desc: "自動化しません。人が手動で送るか、メール送付へ振り替えます" },
  { key: "url_error", title: "URL不正・到達不可", desc: "問い合わせURLを再特定して台帳を直します" },
  { key: "form_error", title: "フォーム不備", desc: "実サイトを見て個別対応が必要です" },
  { key: "uncertain", title: "不確定（送信済・未確認）", desc: "自動再送はしません。人が確認して確定します" },
];

export default async function ExceptionsPage() {
  const { sb } = await getSessionProfile();

  const { data: attempts } = await sb
    .from("send_attempts")
    .select("*, target:outreach_targets(id, media_id, media:media(id, name, domain, note), campaign:campaigns(name))")
    .in("result", ["captcha", "url_error", "form_error", "uncertain"])
    .order("queued_at", { ascending: false })
    .limit(200);

  const { data: noContact } = await sb
    .from("outreach_targets")
    .select("id, media:media(id, name, domain), campaign:campaigns(name)")
    .in("status", ["awaiting_approval", "queued", "confirmed"])
    .limit(200);

  const mediaIds = [...new Set((noContact ?? []).map((t) => (t.media as unknown as { id: string })?.id))].filter(Boolean);
  const { data: contactRows } = mediaIds.length
    ? await sb.from("media_contacts").select("media_id").in("media_id", mediaIds).eq("active", true)
    : { data: [] };
  const hasContact = new Set((contactRows ?? []).map((c) => c.media_id));
  const missing = (noContact ?? []).filter(
    (t) => !hasContact.has((t.media as unknown as { id: string })?.id)
  );

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-bold text-[#1B2A4A]">例外対応キュー</h1>
        <p className="mt-1 text-xs text-slate-500">
          自動化しない・できない件だけをここに集めます。CAPTCHA突破と営業お断りへの送信は行いません。
        </p>
      </header>

      {GROUPS.map((g) => {
        const rows = (attempts ?? []).filter((a) => a.result === g.key);
        return (
          <Card key={g.key} title={`${g.title}（${rows.length}件）`} desc={g.desc}>
            {rows.length === 0 ? (
              <Empty>該当なし。</Empty>
            ) : (
              <table className="grid w-full text-sm">
                <tbody>
                  {rows.map((a) => {
                    const t = a.target as unknown as {
                      id: string;
                      media?: { id: string; name: string; domain: string; note: string };
                      campaign?: { name: string };
                    } | null;
                    return (
                      <tr key={a.id}>
                        <td className="py-2">
                          <Link href={`/media/${t?.media?.id}`} className="font-medium hover:underline">
                            {t?.media?.name || t?.media?.domain}
                          </Link>
                          <div className="text-[11px] text-slate-400">
                            {t?.campaign?.name} / {a.error_detail || "—"}
                          </div>
                        </td>
                        <td className="py-2">
                          {g.key === "url_error" && (
                            <div className="space-y-1">
                              <form action={addContact} className="flex gap-1">
                                <input type="hidden" name="media_id" value={t?.media?.id ?? ""} />
                                <input type="hidden" name="kind" value="form" />
                                <input
                                  name="value"
                                  placeholder="正しい問い合わせURL"
                                  className={`${inputCls} w-64 py-1 text-xs`}
                                />
                                <button className={btnSmall}>台帳に反映</button>
                              </form>
                              <form action={suggestContactFix}>
                                <input type="hidden" name="media_id" value={t?.media?.id ?? ""} />
                                <button className={btnSmall}>AIに候補を出させる</button>
                              </form>
                            </div>
                          )}
                        </td>
                        <td className="py-2 text-right">
                          <form action={recordSendResult} className="inline-flex gap-1">
                            <input type="hidden" name="attempt_id" value={a.id} />
                            <select name="result" className={`${inputCls} w-32 py-1 text-xs`} defaultValue="manual">
                              {Object.entries(SEND_RESULT)
                                .filter(([k]) => k !== "queued")
                                .map(([k, v]) => (
                                  <option key={k} value={k}>
                                    {v}
                                  </option>
                                ))}
                            </select>
                            <input name="detail" placeholder="備考" className={`${inputCls} w-24 py-1 text-xs`} />
                            <button className={btnSmall}>確定</button>
                          </form>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </Card>
        );
      })}

      <Card title={`宛先が未設定（${missing.length}件）`} desc="連絡先が登録されていないため送信できません">
        {missing.length === 0 ? (
          <Empty>該当なし。</Empty>
        ) : (
          <ul className="space-y-2">
            {missing.map((t) => {
              const m = t.media as unknown as { id: string; name: string; domain: string };
              return (
                <li key={t.id} className="flex flex-wrap items-center gap-2 rounded-lg bg-slate-50 px-3 py-2">
                  <Badge tone="bg-amber-100 text-amber-800">宛先なし</Badge>
                  <Link href={`/media/${m?.id}`} className="text-sm hover:underline">
                    {m?.name || m?.domain}
                  </Link>
                  <form action={addContact} className="ml-auto flex gap-1">
                    <input type="hidden" name="media_id" value={m?.id} />
                    <select name="kind" className={`${inputCls} w-24 py-1 text-xs`}>
                      <option value="form">フォーム</option>
                      <option value="mail">メール</option>
                      <option value="dm">DM</option>
                    </select>
                    <input name="value" placeholder="URL / アドレス" className={`${inputCls} w-56 py-1 text-xs`} />
                    <button className={btnSmall}>登録</button>
                  </form>
                  <form action={setTargetStatus}>
                    <input type="hidden" name="ids" value={t.id} />
                    <input type="hidden" name="status" value="excluded" />
                    <input type="hidden" name="reason" value="宛先が特定できない" />
                    <button className={btnGhost}>除外</button>
                  </form>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
