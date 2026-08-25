import Link from "next/link";
import { notFound } from "next/navigation";
import { getSessionProfile } from "@/lib/supabase/server";
import {
  addKeywords,
  deleteKeyword,
  suggestKeywordCandidates,
  adoptKeywordSuggestions,
  dismissKeywordSuggestions,
  refreshKeywordVolumes,
} from "@/app/actions";
import { updateCampaignInfo } from "@/app/start-actions";
import BoardView from "@/components/BoardView";
import CampaignJobs, { type CampaignGroup, type JobInfo } from "@/app/(app)/start/CampaignJobs";
import { Card, Empty, Badge, btnSmall, inputCls, labelCls } from "@/components/ui";
import SubmitButton from "@/components/SubmitButton";
import CampaignDocsCard from "@/components/CampaignDocsCard";
import { loadCampaignCost } from "@/lib/cost-data";
import { fmtYen } from "@/lib/ai-cost";

export const dynamic = "force-dynamic";
// 収集状況タブの自動収集アクションはこのセグメントで実行される（Web検索が長いため180秒）
export const maxDuration = 180;

const TABS = [
  { id: "collect", label: "収集状況" },
  { id: "board", label: "陣取りボード" },
  { id: "info", label: "案件情報・KW" },
  { id: "cost", label: "AIコスト" },
] as const;

type TabId = (typeof TABS)[number]["id"];

/** DataForSEO の competition（LOW/MEDIUM/HIGH）の表示ラベル */
const COMPETITION_LABEL: Record<string, string> = {
  LOW: "低",
  MEDIUM: "中",
  HIGH: "高",
};

/** 月間検索数。データが無い語（null）と 0 は意味が違うので分けて出す */
function fmtVolume(v: number | null | undefined): string {
  if (v == null) return "—";
  return v.toLocaleString("ja-JP");
}

type JobRow = {
  id: string;
  keyword_id: string;
  status: "pending" | "running" | "done" | "error";
  found_count: number;
  ranking_count: number;
  paid_count: number;
  error_detail: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
};

export default async function CampaignDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; autorun?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const tab: TabId = (TABS.some((t) => t.id === sp.tab) ? sp.tab : "collect") as TabId;
  const { sb } = await getSessionProfile();
  // 検索ボリューム・関連KWの実データは DataForSEO 依存。未設定なら画面で理由を出す
  const hasVolumeSource = !!(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);

  const { data: c } = await sb
    .from("campaigns")
    .select("*, client:clients(name)")
    .eq("id", id)
    .maybeSingle();
  if (!c) notFound();

  const [{ data: kws }, { data: jobs }, { data: suggestions }, cost] = await Promise.all([
    sb
      .from("keywords")
      .select("*, snapshots:serp_snapshots(id, collected_at)")
      .eq("campaign_id", id)
      .order("created_at"),
    sb
      .from("collection_jobs")
      .select("id, keyword_id, status, found_count, ranking_count, paid_count, error_detail, started_at, finished_at, created_at")
      .eq("campaign_id", id)
      .order("created_at", { ascending: false }),
    sb
      .from("keyword_suggestions")
      .select("id, keyword, search_volume, competition, source, reason")
      .eq("campaign_id", id)
      .eq("status", "suggested")
      .order("search_volume", { ascending: false, nullsFirst: false })
      .limit(120),
    loadCampaignCost(sb, id),
  ]);

  const clientName = (c.client as unknown as { name: string } | null)?.name ?? "";

  // 収集状況タブ用のグループ（KW×最新ジョブ）
  const latestByKw = new Map<string, JobRow>();
  for (const j of (jobs ?? []) as JobRow[]) if (!latestByKw.has(j.keyword_id)) latestByKw.set(j.keyword_id, j);
  const group: CampaignGroup = {
    id,
    name: c.name,
    client: clientName,
    last_collected:
      ((jobs ?? []) as JobRow[])
        .map((j) => j.finished_at)
        .filter(Boolean)
        .sort()
        .at(-1) ?? null,
    kws: (kws ?? []).map((k) => {
      const j = latestByKw.get(k.id);
      const job: JobInfo | null = j
        ? {
            job_id: j.id,
            status: j.status,
            found: j.found_count ?? 0,
            ranking: j.ranking_count ?? 0,
            paid: j.paid_count ?? 0,
            error: j.error_detail ?? "",
            started_at: j.started_at,
            finished_at: j.finished_at,
          }
        : null;
      return { keyword_id: k.id, keyword: k.keyword, job };
    }),
  };

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs text-slate-500">
          <Link href="/start" className="hover:underline">
            案件・収集
          </Link>{" "}
          / {clientName || "クライアント未設定"}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-bold text-[#1B2A4A]">{c.name}</h1>
          <Badge tone={c.status === "active" ? "bg-emerald-100 text-emerald-800" : "bg-zinc-200 text-zinc-600"}>
            {c.status === "active" ? "進行中" : c.status === "paused" ? "一時停止" : "終了"}
          </Badge>
        </div>
        <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-600">
          <span className="rounded-lg bg-slate-100 px-2 py-1">KW {(kws ?? []).length}件</span>
          <span className="rounded-lg bg-slate-100 px-2 py-1">
            最終収集 {group.last_collected ? new Date(group.last_collected).toLocaleString("ja-JP") : "—"}
          </span>
          <Link href={`/campaigns/${id}?tab=cost`} className="rounded-lg bg-amber-50 px-2 py-1 text-amber-900 hover:bg-amber-100">
            AIコスト {cost.calls ? fmtYen(cost.totalUsd) : "—"}
          </Link>
        </div>
      </header>

      {/* タブ */}
      <nav className="flex flex-wrap gap-1.5 border-b border-slate-200 pb-2">
        {TABS.map((t) => (
          <Link
            key={t.id}
            href={`/campaigns/${id}?tab=${t.id}`}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold ${
              tab === t.id
                ? "bg-[#1B2A4A] text-white"
                : "bg-white text-slate-600 hover:bg-slate-100"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </nav>

      {tab === "collect" && (
        <>
          <p className="text-xs text-slate-500">
            画面を閉じても収集は続きます（サーバー側で1分ごとに未実行のKWを拾って進めます）。ここは進捗の確認用です。
          </p>
          <CampaignJobs
            group={group}
            boardHref={`/campaigns/${id}?tab=board`}
            autoResume={sp.autorun === "1"}
          />
        </>
      )}

      {tab === "board" && <BoardView campaignId={id} />}

      {tab === "cost" && (
        <div className="space-y-6">
          <Card
            title="この案件にかかったAI利用料"
            desc="実際に使ったトークン数から、実行時点の単価で計算した実績です（USD建ての請求を円換算した目安）"
          >
            {cost.calls === 0 ? (
              <Empty>
                まだ記録がありません。計測はこの機能を入れた時点以降の実行分から積み上がります。
                収集を1回動かすと数字が入ります。
              </Empty>
            ) : (
              <>
                <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
                  <div>
                    <div className="text-3xl font-bold text-[#1B2A4A]">{fmtYen(cost.totalUsd)}</div>
                    <div className="text-[11px] text-slate-500">${cost.totalUsd.toFixed(2)}</div>
                  </div>
                  <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-600">
                    <div>
                      <dt className="inline text-slate-400">AI呼び出し </dt>
                      <dd className="inline font-semibold tabular-nums">{cost.calls.toLocaleString("ja-JP")}回</dd>
                    </div>
                    <div>
                      <dt className="inline text-slate-400">入力 </dt>
                      <dd className="inline font-semibold tabular-nums">
                        {(cost.inputTokens / 1000).toLocaleString("ja-JP", { maximumFractionDigits: 0 })}Kトークン
                      </dd>
                    </div>
                    <div>
                      <dt className="inline text-slate-400">出力 </dt>
                      <dd className="inline font-semibold tabular-nums">
                        {(cost.outputTokens / 1000).toLocaleString("ja-JP", { maximumFractionDigits: 0 })}Kトークン
                      </dd>
                    </div>
                    <div>
                      <dt className="inline text-slate-400">最終 </dt>
                      <dd className="inline">{cost.lastAt ? new Date(cost.lastAt).toLocaleString("ja-JP") : "—"}</dd>
                    </div>
                  </dl>
                </div>

                <table className="tbl mt-5 w-full text-sm">
                  <thead>
                    <tr className="text-left text-[11px] text-slate-500">
                      <th className="pb-2">処理</th>
                      <th className="pb-2 text-right">金額</th>
                      <th className="pb-2 text-right">割合</th>
                      <th className="pb-2 text-right">呼び出し</th>
                      <th className="pb-2 text-right">入力トークン</th>
                      <th className="pb-2 text-right">出力トークン</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cost.byKind.map((k) => {
                      const share = cost.totalUsd ? k.costUsd / cost.totalUsd : 0;
                      return (
                        <tr key={k.kind}>
                          <td className="py-2 font-medium">{k.label}</td>
                          <td className="py-2 text-right tabular-nums">{fmtYen(k.costUsd)}</td>
                          <td className="py-2 text-right">
                            <div className="flex items-center justify-end gap-2">
                              <div className="h-1.5 w-20 overflow-hidden rounded bg-slate-100">
                                <div className="h-full bg-[#1B2A4A]" style={{ width: `${Math.round(share * 100)}%` }} />
                              </div>
                              <span className="tabular-nums text-[11px] text-slate-500">
                                {Math.round(share * 100)}%
                              </span>
                            </div>
                          </td>
                          <td className="py-2 text-right tabular-nums">{k.calls.toLocaleString("ja-JP")}</td>
                          <td className="py-2 text-right tabular-nums text-slate-500">
                            {k.inputTokens.toLocaleString("ja-JP")}
                          </td>
                          <td className="py-2 text-right tabular-nums text-slate-500">
                            {k.outputTokens.toLocaleString("ja-JP")}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </>
            )}
          </Card>

          {cost.byKeyword.length > 0 && (
            <Card title="キーワード別" desc="どのKWにコストがかかっているか（上位10件）">
              <table className="tbl w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] text-slate-500">
                    <th className="pb-2">キーワード</th>
                    <th className="pb-2 text-right">金額</th>
                    <th className="pb-2 text-right">呼び出し</th>
                  </tr>
                </thead>
                <tbody>
                  {cost.byKeyword.map((k) => (
                    <tr key={k.keyword}>
                      <td className="py-2 font-medium">{k.keyword}</td>
                      <td className="py-2 text-right tabular-nums">{fmtYen(k.costUsd)}</td>
                      <td className="py-2 text-right tabular-nums">{k.calls.toLocaleString("ja-JP")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-3 text-[11px] text-slate-400">
                案件作成前に動く「案件ドラフト作成」は、案件がまだ存在しないため案件別の集計には入りません。
              </p>
            </Card>
          )}
        </div>
      )}

      {tab === "info" && (
        <div className="space-y-6">
          <Card title="案件情報" desc="変更は文面生成・報告書に反映されます">
            <form action={updateCampaignInfo} className="grid gap-4 md:grid-cols-2">
              <input type="hidden" name="id" value={id} />
              <div>
                <label className={labelCls}>案件名 *</label>
                <input name="name" required defaultValue={c.name} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>商材名</label>
                <input name="product_name" defaultValue={c.product_name} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>LP URL</label>
                <input name="lp_url" defaultValue={c.lp_url} className={inputCls} placeholder="https://" />
              </div>
              <div>
                <label className={labelCls}>単価（グロス／ネット）</label>
                <input name="unit_price" defaultValue={c.unit_price} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>成果地点</label>
                <input name="conversion_point" defaultValue={c.conversion_point} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>承認条件</label>
                <input name="approval_terms" defaultValue={c.approval_terms} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>ジャンル</label>
                <input name="genre" defaultValue={c.genre ?? ""} className={inputCls} placeholder="起業家育成スクール" />
              </div>
              <div>
                <label className={labelCls}>参考URL</label>
                <input name="reference_url" defaultValue={c.reference_url ?? ""} className={inputCls} placeholder="https://" />
              </div>
              <div>
                <label className={labelCls}>入稿URL</label>
                <input name="draft_url" defaultValue={c.draft_url ?? ""} className={inputCls} placeholder="https://" />
              </div>
              <div className="md:col-span-2">
                <label className={labelCls}>訴求ポイント・信用点</label>
                <textarea name="selling_points" defaultValue={c.selling_points} rows={2} className={inputCls} />
              </div>
              <div className="md:col-span-2">
                <label className={labelCls}>
                  案件カルテ
                  <span className="ml-1 font-normal text-slate-400">
                    理想のユーザー像・NG層・検索意図・推奨KWなど。陣取り表のヘッダーにそのまま出ます
                  </span>
                </label>
                <textarea
                  name="brief"
                  defaultValue={c.brief ?? ""}
                  rows={10}
                  className={`${inputCls} font-mono text-xs`}
                  placeholder={"① 理想のユーザー像\n・…\n\n② NGユーザー層\n・…\n\n③ 受講者の検索意図\n・…\n\n④ SEO検索キーワードの希望\n・…"}
                />
              </div>
              <div className="md:col-span-2">
                <SubmitButton variant="accent">保存</SubmitButton>
              </div>
            </form>
          </Card>

          <CampaignDocsCard campaignId={id} />

          <Card
            title="キーワードを追加"
            desc="件数の上限はありません。1KWごとに検索1回ぶんのAPI料金がかかります"
          >
            <form action={addKeywords} className="space-y-3">
              <input type="hidden" name="campaign_id" value={id} />
              <textarea
                name="keywords"
                rows={4}
                className={inputCls}
                placeholder={"改行または読点で区切って入力（何件でも可）"}
              />
              <SubmitButton variant="accent">追加</SubmitButton>
            </form>
            <div className="mt-3 flex flex-wrap gap-2">
              <form action={suggestKeywordCandidates}>
                <input type="hidden" name="campaign_id" value={id} />
                <SubmitButton variant="ghost" pendingLabel="候補を集めています…">
                  KW候補を出す
                </SubmitButton>
              </form>
              <form action={refreshKeywordVolumes}>
                <input type="hidden" name="campaign_id" value={id} />
                <SubmitButton variant="ghost" pendingLabel="取得中…">
                  検索ボリュームを取り直す
                </SubmitButton>
              </form>
            </div>
            {!hasVolumeSource && (
              <p className="mt-2 text-[11px] text-amber-700">
                検索ボリュームの取得には DataForSEO の認証情報（DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD）が必要です。
                未設定のあいだ、KW候補はAIの提案のみ・ボリュームは空欄になります。
              </p>
            )}
          </Card>

          <Card
            title="KW候補"
            desc="採用したものだけが収集対象になります（AIの提案＋関連キーワードの実データ）"
          >
            {(suggestions ?? []).length === 0 ? (
              <Empty>候補がありません。「KW候補を出す」で提案を集めてください。</Empty>
            ) : (
              <form action={adoptKeywordSuggestions}>
                <input type="hidden" name="campaign_id" value={id} />
                <div className="max-h-96 overflow-y-auto">
                  <table className="tbl w-full text-sm">
                    <thead>
                      <tr className="text-left text-[11px] text-slate-500">
                        <th className="pb-2 w-8"></th>
                        <th className="pb-2">キーワード</th>
                        <th className="pb-2 text-right">月間検索数</th>
                        <th className="pb-2">競合性</th>
                        <th className="pb-2">出所・理由</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(suggestions ?? []).map((sg) => (
                        <tr key={sg.id}>
                          <td className="py-1.5">
                            <input type="checkbox" name="ids" value={sg.id} />
                          </td>
                          <td className="py-1.5 font-medium">{sg.keyword}</td>
                          <td className="py-1.5 text-right tabular-nums">{fmtVolume(sg.search_volume)}</td>
                          <td className="py-1.5 text-slate-600">{COMPETITION_LABEL[sg.competition] ?? "—"}</td>
                          <td className="py-1.5 text-slate-500">
                            {sg.source === "dataforseo" ? "関連KW" : "AI提案"}
                            {sg.reason ? `／${sg.reason}` : ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  <SubmitButton variant="accent">チェックしたKWを追加</SubmitButton>
                  <button formAction={dismissKeywordSuggestions} className={btnSmall}>
                    チェックした候補を見送る
                  </button>
                </div>
              </form>
            )}
          </Card>

          <Card title="キーワード一覧" desc="収集の実行単位。定点観測の履歴もここに紐づきます">
            {(kws ?? []).length === 0 ? (
              <Empty>キーワードが未登録です。</Empty>
            ) : (
              <table className="tbl w-full text-sm">
                <thead>
                  <tr className="text-left text-[11px] text-slate-500">
                    <th className="pb-2">キーワード</th>
                    <th className="pb-2 text-right">月間検索数</th>
                    <th className="pb-2">競合性</th>
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
                        <td className="py-2 text-right tabular-nums">{fmtVolume(k.search_volume)}</td>
                        <td className="py-2 text-slate-600">{COMPETITION_LABEL[k.competition] ?? "—"}</td>
                        <td className="py-2 text-right">{snaps.length}</td>
                        <td className="py-2 text-slate-600">
                          {last ? new Date(last).toLocaleString("ja-JP") : "未収集"}
                        </td>
                        <td className="py-2 text-right">
                          <Link href={`/campaigns/${id}?tab=collect`} className={btnSmall}>
                            収集状況へ
                          </Link>{" "}
                          <Link href={`/collect?campaign=${id}&keyword=${k.id}`} className={btnSmall}>
                            貼り付け収集
                          </Link>{" "}
                          <form action={deleteKeyword} className="inline">
                            <input type="hidden" name="id" value={k.id} />
                            <input type="hidden" name="campaign_id" value={id} />
                            <SubmitButton variant="small">削除</SubmitButton>
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
      )}
    </div>
  );
}
