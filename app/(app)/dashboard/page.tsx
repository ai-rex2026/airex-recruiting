import Link from "next/link";
import { getSessionProfile } from "@/lib/supabase/server";
import { Card, Stat, Badge, Empty } from "@/components/ui";
import { OUTREACH_STATUS, statusTone } from "@/lib/domain";

export const dynamic = "force-dynamic";

const FUNNEL: { key: string; label: string }[] = [
  { key: "collected", label: "収集済" },
  { key: "confirmed", label: "対象確定" },
  { key: "awaiting_approval", label: "承認待ち" },
  { key: "queued", label: "送信待ち" },
  { key: "sent", label: "送信済" },
  { key: "replied", label: "返信あり" },
  { key: "placed", label: "掲載中" },
  { key: "reported", label: "報告済" },
];

export default async function Dashboard() {
  const { sb } = await getSessionProfile();

  const { data: targets } = await sb
    .from("outreach_targets")
    .select("id, status, campaign_id, campaign:campaigns(name)");
  const { data: attempts } = await sb.from("send_attempts").select("result");
  const { data: audits } = await sb
    .from("audit_logs")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(8);
  const { count: mediaCount } = await sb
    .from("media")
    .select("id", { count: "exact", head: true });
  const { count: noSol } = await sb
    .from("media")
    .select("id", { count: "exact", head: true })
    .eq("no_solicitation", true);

  const all = targets ?? [];
  const by = (s: string) => all.filter((t) => t.status === s).length;

  const sent = (attempts ?? []).filter((a) => a.result === "success").length;
  const tried = (attempts ?? []).filter((a) => a.result !== "queued").length;
  const reach = tried ? Math.round((sent / tried) * 100) : 0;
  const replied = all.filter((t) =>
    ["replied", "negotiating", "placeable", "placed", "reported", "rejected"].includes(t.status)
  ).length;
  const replyRate = sent ? Math.round((replied / sent) * 100) : 0;
  const placed = all.filter((t) => ["placed", "reported"].includes(t.status)).length;

  // 案件別
  const byCampaign = new Map<string, { name: string; total: number; placed: number }>();
  for (const t of all) {
    const c = t.campaign as unknown as { name: string } | null;
    const key = t.campaign_id;
    const cur = byCampaign.get(key) ?? { name: c?.name ?? "(不明)", total: 0, placed: 0 };
    cur.total++;
    if (["placed", "reported"].includes(t.status)) cur.placed++;
    byCampaign.set(key, cur);
  }

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-bold text-[#1B2A4A]">ダッシュボード</h1>
        <p className="mt-1 text-xs text-slate-500">
          いま判断を待っている件と、案件別のファネルを一覧します。
        </p>
      </header>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="承認待ち" value={by("awaiting_approval")} sub="承認キューへ" href="/queue" />
        <Stat label="返信の分類待ち" value={by("replied")} sub="承認キューへ" href="/queue?tab=reply" />
        <Stat
          label="例外対応"
          value={by("exception") + by("uncertain")}
          sub="CAPTCHA・URL不正など"
          href="/exceptions"
        />
        <Stat label="掲載中／報告済" value={placed} sub="掲載・報告へ" href="/placements" />
        <Stat
          label="メディア台帳"
          value={mediaCount ?? 0}
          sub={`うち営業お断り ${noSol ?? 0}件`}
          href="/media"
        />
      </div>

      <Card title="ファネル（全案件）" desc="収集 → 打診 → 送信 → 返信 → 掲載 の各段階">
        <div className="flex flex-wrap items-end gap-2">
          {FUNNEL.map((f) => {
            const n = by(f.key);
            return (
              <div
                key={f.key}
                className="min-w-[92px] flex-1 rounded-lg border border-slate-200 px-3 py-2"
              >
                <div className="text-[11px] text-slate-500">{f.label}</div>
                <div className="text-lg font-bold text-[#1B2A4A]">{n}</div>
              </div>
            );
          })}
        </div>
        <div className="mt-4 grid grid-cols-3 gap-3 text-sm">
          <div className="rounded-lg bg-slate-50 px-3 py-2">
            <div className="text-[11px] text-slate-500">フォーム到達率</div>
            <div className="font-bold text-[#1B2A4A]">{reach}%</div>
          </div>
          <div className="rounded-lg bg-slate-50 px-3 py-2">
            <div className="text-[11px] text-slate-500">返信率（送信成功に対する）</div>
            <div className="font-bold text-[#1B2A4A]">{replyRate}%</div>
          </div>
          <div className="rounded-lg bg-slate-50 px-3 py-2">
            <div className="text-[11px] text-slate-500">掲載獲得率</div>
            <div className="font-bold text-[#1B2A4A]">
              {sent ? Math.round((placed / sent) * 100) : 0}%
            </div>
          </div>
        </div>
        <p className="mt-3 text-[11px] text-slate-400">
          打診数だけを増やして返信率が下がるのは、メディアとの関係を消費しているだけです。両方を同時に見てください。
        </p>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="案件別" desc="打診総数と掲載成立">
          {byCampaign.size === 0 ? (
            <Empty>
              まだ案件がありません。<Link href="/campaigns" className="underline">案件を登録</Link>してください。
            </Empty>
          ) : (
            <table className="grid w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] text-slate-500">
                  <th className="pb-2">案件</th>
                  <th className="pb-2 text-right">打診</th>
                  <th className="pb-2 text-right">掲載</th>
                </tr>
              </thead>
              <tbody>
                {[...byCampaign.entries()].map(([id, v]) => (
                  <tr key={id}>
                    <td className="py-2">
                      <Link href={`/board?campaign=${id}`} className="hover:underline">
                        {v.name}
                      </Link>
                    </td>
                    <td className="py-2 text-right">{v.total}</td>
                    <td className="py-2 text-right font-semibold">{v.placed}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card title="直近の操作" desc="監査ログの末尾8件">
          {(audits ?? []).length === 0 ? (
            <Empty>まだ操作履歴がありません。</Empty>
          ) : (
            <ul className="space-y-2 text-xs">
              {(audits ?? []).map((a) => (
                <li key={a.id} className="flex items-start gap-2">
                  <Badge tone={statusTone("")}>{a.entity}</Badge>
                  <div className="min-w-0">
                    <div className="text-slate-700">
                      {a.action}
                      {a.detail ? ` — ${a.detail}` : ""}
                    </div>
                    <div className="text-slate-400">
                      {a.actor_name || "—"} / {new Date(a.created_at).toLocaleString("ja-JP")}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="ステータス内訳" desc="要件定義書 7.1 の状態遷移に対応">
        <div className="flex flex-wrap gap-2">
          {Object.entries(OUTREACH_STATUS).map(([k, label]) => (
            <span key={k} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-2.5 py-1 text-xs">
              <Badge tone={statusTone(k)}>{label}</Badge>
              <span className="font-semibold text-slate-700">{by(k)}</span>
            </span>
          ))}
        </div>
      </Card>
    </div>
  );
}
