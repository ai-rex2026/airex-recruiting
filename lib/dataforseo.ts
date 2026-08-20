/**
 * DataForSEO クライアント。
 *
 * このアプリで外部の実データが要るのは次の3つで、いずれも DataForSEO の1アカウントで賄う。
 *  - 検索ボリューム（Google 広告のキーワードプランナー由来）
 *  - KW候補（シードKWからの関連キーワード＋ボリューム）
 *  - SERP（**スポンサー広告 paid とオーガニック organic を分けて**返す）
 *
 * Claude の web_search ツールは広告枠を返さないため、赤枠（スポンサー広告）の取得はここでしかできない。
 * 未設定なら hasDataForSeo() が false を返し、収集は従来どおり web_search にフォールバックする。
 */

const BASE = "https://api.dataforseo.com/v3";

/** 日本（location_code）／日本語。SERP・ボリュームとも日本固定で取る */
const LOCATION_JP = 2392;
const LANGUAGE_JA = "ja";

export function hasDataForSeo(): boolean {
  return !!(process.env.DATAFORSEO_LOGIN && process.env.DATAFORSEO_PASSWORD);
}

function authHeader(): string {
  const token = Buffer.from(
    `${process.env.DATAFORSEO_LOGIN}:${process.env.DATAFORSEO_PASSWORD}`
  ).toString("base64");
  return `Basic ${token}`;
}

type TaskEnvelope<R> = {
  status_code: number;
  status_message: string;
  tasks?: {
    status_code: number;
    status_message: string;
    result?: R[] | null;
  }[];
};

/**
 * DataForSEO の live エンドポイントを叩いて最初のタスクの result を返す。
 * 失敗は例外にせず null を返す（収集がまるごと落ちるより、広告なし・ボリュームなしで続行させたい）。
 */
async function postLive<R>(
  path: string,
  body: unknown[],
  timeoutMs = 60_000
): Promise<{ ok: true; result: R[] } | { ok: false; error: string }> {
  if (!hasDataForSeo()) return { ok: false, error: "DataForSEO の認証情報（DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD）が未設定です。" };
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: authHeader(), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `DataForSEO への接続に失敗しました（${msg.slice(0, 120)}）。` };
  }
  if (!res.ok) {
    if (res.status === 401) return { ok: false, error: "DataForSEO の認証に失敗しました（ログイン／パスワードをご確認ください）。" };
    return { ok: false, error: `DataForSEO がエラーを返しました（HTTP ${res.status}）。` };
  }

  let json: TaskEnvelope<R>;
  try {
    json = (await res.json()) as TaskEnvelope<R>;
  } catch {
    return { ok: false, error: "DataForSEO の応答を解析できませんでした。" };
  }
  const task = json.tasks?.[0];
  if (!task) return { ok: false, error: `DataForSEO の応答が空でした（${json.status_message || json.status_code}）。` };
  // 20000 番台が成功。40402（残高不足）などはメッセージをそのまま見せたい
  if (task.status_code < 20000 || task.status_code >= 30000) {
    return { ok: false, error: `DataForSEO：${task.status_message}（${task.status_code}）` };
  }
  return { ok: true, result: task.result ?? [] };
}

/* ============================ 検索ボリューム ============================ */

export type KeywordVolume = {
  keyword: string;
  /** 月間平均検索数。データが無い語は null（0 と区別する） */
  search_volume: number | null;
  cpc: number | null;
  /** LOW | MEDIUM | HIGH */
  competition: string;
};

type VolumeItem = {
  keyword?: string;
  search_volume?: number | null;
  cpc?: number | null;
  competition?: string | null;
};

/** Google 広告のキーワードプランナー由来の月間検索ボリュームを引く（1回あたり最大1000語） */
export async function fetchSearchVolume(
  keywords: string[]
): Promise<{ ok: true; volumes: KeywordVolume[] } | { ok: false; error: string }> {
  const list = Array.from(new Set(keywords.map((k) => k.trim()).filter(Boolean)));
  if (!list.length) return { ok: true, volumes: [] };

  const out: KeywordVolume[] = [];
  // API の上限が1リクエスト1000語なので分割して投げる
  for (let i = 0; i < list.length; i += 1000) {
    const chunk = list.slice(i, i + 1000);
    const res = await postLive<VolumeItem>(
      "/keywords_data/google_ads/search_volume/live",
      [{ keywords: chunk, location_code: LOCATION_JP, language_code: LANGUAGE_JA }]
    );
    if (!res.ok) return res;
    for (const r of res.result) {
      if (!r?.keyword) continue;
      out.push({
        keyword: String(r.keyword),
        search_volume: typeof r.search_volume === "number" ? r.search_volume : null,
        cpc: typeof r.cpc === "number" ? r.cpc : null,
        competition: String(r.competition ?? ""),
      });
    }
  }
  return { ok: true, volumes: out };
}

/* ============================ KW候補 ============================ */

/** シードKWから関連キーワードをボリューム付きで引く（Google 広告の「キーワード候補」相当） */
export async function fetchKeywordIdeas(
  seeds: string[],
  limit = 200
): Promise<{ ok: true; ideas: KeywordVolume[] } | { ok: false; error: string }> {
  const list = Array.from(new Set(seeds.map((k) => k.trim()).filter(Boolean))).slice(0, 20);
  if (!list.length) return { ok: true, ideas: [] };

  const res = await postLive<VolumeItem>(
    "/keywords_data/google_ads/keywords_for_keywords/live",
    [
      {
        keywords: list,
        location_code: LOCATION_JP,
        language_code: LANGUAGE_JA,
        sort_by: "search_volume",
      },
    ]
  );
  if (!res.ok) return res;

  const ideas = res.result
    .filter((r) => !!r?.keyword)
    .map((r) => ({
      keyword: String(r.keyword),
      search_volume: typeof r.search_volume === "number" ? r.search_volume : null,
      cpc: typeof r.cpc === "number" ? r.cpc : null,
      competition: String(r.competition ?? ""),
    }))
    .sort((a, b) => (b.search_volume ?? -1) - (a.search_volume ?? -1))
    .slice(0, limit);
  return { ok: true, ideas };
}

/* ============================ SERP（広告＋オーガニック） ============================ */

/** 検索結果1件。スポンサー広告（赤枠）とオーガニック（青枠）を result_type で区別する */
export type SerpItem = {
  /** paid = スポンサー広告 / organic = オーガニック検索 */
  result_type: "paid" | "organic";
  /** その区分内での順位（広告なら広告枠内の1,2,3…／オーガニックなら検索順位） */
  rank: number;
  title: string;
  url: string;
  domain: string;
  description: string;
};

type SerpApiItem = {
  type?: string;
  rank_group?: number | null;
  rank_absolute?: number | null;
  title?: string | null;
  url?: string | null;
  domain?: string | null;
  description?: string | null;
};

/**
 * Google 検索結果を広告枠込みで取得する。
 * items には people_also_ask など多様な type が混ざるので paid / organic だけを拾う。
 */
export async function fetchSerp(
  keyword: string,
  depth = 20
): Promise<{ ok: true; items: SerpItem[] } | { ok: false; error: string }> {
  const res = await postLive<{ items?: SerpApiItem[] | null }>(
    "/serp/google/organic/live/advanced",
    [
      {
        keyword,
        location_code: LOCATION_JP,
        language_code: LANGUAGE_JA,
        device: "desktop",
        depth,
      },
    ],
    90_000
  );
  if (!res.ok) return res;

  const raw = res.result[0]?.items ?? [];
  const items: SerpItem[] = [];
  let paidRank = 0;
  let organicRank = 0;
  for (const it of raw) {
    const type = String(it?.type ?? "");
    if (type !== "paid" && type !== "organic") continue;
    const url = String(it?.url ?? "").trim();
    if (!url) continue;
    const isPaid = type === "paid";
    // 広告枠の順位は SERP 全体の rank ではなく「広告の中で何番目か」を持たせる（画面の見え方に合わせる）
    const rank = isPaid ? ++paidRank : it?.rank_group ?? ++organicRank;
    if (!isPaid) organicRank = Math.max(organicRank, rank);
    items.push({
      result_type: isPaid ? "paid" : "organic",
      rank,
      title: String(it?.title ?? ""),
      url,
      domain: String(it?.domain ?? ""),
      description: String(it?.description ?? ""),
    });
  }
  return { ok: true, items };
}
