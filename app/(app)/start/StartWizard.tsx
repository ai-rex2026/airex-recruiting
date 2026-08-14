"use client";

import { useRef, useState } from "react";
import { Card, btnAccent, btnGhost, inputCls, labelCls } from "@/components/ui";
import { createClient } from "@/lib/supabase/client";
import { registerDocument, extractDocument, type BriefExtract } from "@/app/document-actions";
import {
  proposeCampaignFromInput,
  createCampaignFromDraft,
  type CampaignDraft,
  type RunnableJob,
} from "@/app/start-actions";

type KwRow = { keyword: string; priority: number; checked: boolean };

/**
 * かんたん開始ウィザード（Step1: 入力 → Step2: 確認・作成）。
 * 案件と収集ジョブを作成したら onCreated に引き渡す。実行と進捗表示は収集センター（一覧側）が担当する。
 */
export default function StartWizard({
  onCreated,
  tenantId,
}: {
  onCreated: (campaignId: string, jobs: RunnableJob[]) => void;
  tenantId: string;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Step1
  const [inputUrl, setInputUrl] = useState("");
  const [inputText, setInputText] = useState("");

  const fileRef = useRef<HTMLInputElement>(null);
  const [docName, setDocName] = useState<string | null>(null);

  // Step2
  const [draft, setDraft] = useState<CampaignDraft | null>(null);
  const [kws, setKws] = useState<KwRow[]>([]);

  /**
   * 案件資料から作る。LPには載らない報酬条件・承認条件・NG層まで読めるので、
   * 資料がある場合はこちらが本筋。ファイルはサイズ制限を避けて Storage へ直接送る。
   */
  const analyzeDocument = async (file: File) => {
    setError(null);
    setNote(null);
    if (!/\.(pdf|docx|xlsx|xlsm|pptx)$/i.test(file.name)) {
      setError("PDF / Word(.docx) / Excel(.xlsx) / PowerPoint(.pptx) のいずれかを選んでください。");
      return;
    }
    if (file.size > 32 * 1024 * 1024) {
      setError("ファイルが大きすぎます（上限32MB）。");
      return;
    }
    setBusy(true);
    try {
      const path = `${tenantId}/campaign_brief/new/${crypto.randomUUID()}-${file.name}`;
      const sb = createClient();
      const up = await sb.storage.from("documents").upload(path, file, {
        contentType: file.type || "application/octet-stream",
      });
      if (up.error) throw new Error(`アップロードに失敗しました：${up.error.message}`);

      const reg = await registerDocument({
        kind: "campaign_brief",
        file_name: file.name,
        storage_path: path,
        mime_type: file.type || "",
        byte_size: file.size,
      });
      if (!reg.ok) throw new Error(reg.error);

      const ex = await extractDocument(reg.id);
      if (!ex.ok) throw new Error(ex.error);

      const b = ex.extracted as BriefExtract;
      const kwList = (b.keywords || []).filter((k) => k?.keyword);
      if (!kwList.length) {
        setNote("資料からキーワードを読み取れませんでした。次の画面で追加してください。");
      }
      setDraft({
        client_name: b.client_name || "",
        campaign_name: b.campaign_name || `${b.product_name || file.name} 掲載獲得`,
        product_name: b.product_name || "",
        selling_points: b.selling_points || "",
        conversion_point: b.conversion_point || "",
        keywords: kwList,
        genre: b.genre || "",
        lp_url: b.lp_url || "",
        reference_url: b.reference_url || "",
        draft_url: b.draft_url || "",
        unit_price: b.unit_price || "",
        approval_terms: b.approval_terms || "",
        brief: b.brief || "",
        document_id: reg.id,
      });
      setDocName(file.name);
      setKws(kwList.map((k) => ({ keyword: k.keyword, priority: k.priority, checked: true })));
      setStep(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : "資料の読み取りに失敗しました。");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const analyze = async () => {
    setError(null);
    if (!inputUrl.trim() && !inputText.trim()) {
      setError("商品LPのURL、または商品説明のテキストのどちらかを入力してください。");
      return;
    }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.set("input_url", inputUrl.trim());
      fd.set("input_text", inputText.trim());
      const res = await proposeCampaignFromInput(fd);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setDraft(res.draft);
      setNote(res.note ?? null);
      setKws(res.draft.keywords.map((k) => ({ keyword: k.keyword, priority: k.priority, checked: true })));
      setStep(2);
    } catch (e) {
      setError(e instanceof Error ? e.message : "分析に失敗しました。もう一度お試しください。");
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    if (!draft) return;
    setError(null);
    const selected = kws.filter((k) => k.checked && k.keyword.trim());
    if (!selected.length) {
      setError("キーワードを1つ以上選択してください。");
      return;
    }
    setBusy(true);
    try {
      const res = await createCampaignFromDraft({
        client_name: draft.client_name,
        campaign_name: draft.campaign_name,
        product_name: draft.product_name,
        selling_points: draft.selling_points,
        conversion_point: draft.conversion_point,
        input_url: inputUrl.trim(),
        keywords: selected.map((k) => ({ keyword: k.keyword.trim(), priority: k.priority })),
        genre: draft.genre,
        lp_url: draft.lp_url,
        reference_url: draft.reference_url,
        draft_url: draft.draft_url,
        unit_price: draft.unit_price,
        approval_terms: draft.approval_terms,
        brief: draft.brief,
        document_id: draft.document_id,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // リセットして一覧側へ引き渡し（自動収集は一覧の行で進捗表示される）
      setStep(1);
      setInputUrl("");
      setInputText("");
      setDraft(null);
      setKws([]);
      setDocName(null);
      onCreated(res.campaign_id, res.jobs);
    } finally {
      setBusy(false);
    }
  };

  const setDraftField = (field: keyof CampaignDraft, value: string) =>
    setDraft((d) => (d ? { ...d, [field]: value } : d));

  return (
    <div className="space-y-4">
      {/* ステップ表示 */}
      <ol className="flex flex-wrap gap-2 text-xs">
        {[
          [1, "商品を教えてください"],
          [2, "案件とキーワードの確認"],
        ].map(([n, label]) => (
          <li
            key={n}
            className={`rounded-full px-3 py-1.5 font-semibold ${
              step === n
                ? "bg-[#1B2A4A] text-white"
                : step > (n as number)
                ? "bg-emerald-100 text-emerald-800"
                : "bg-slate-100 text-slate-500"
            }`}
          >
            {n}. {label}
          </li>
        ))}
      </ol>

      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}

      {step === 1 && (
        <Card
          title="商品を教えてください"
          desc="案件資料をアップロードするか、商品LPのURL・テキストを入力してください。"
        >
          <div className="space-y-4">
            <div className="rounded-lg border border-[#F0D9C8] bg-[#FDF7F2] p-3">
              <label className={labelCls}>案件資料から作る（おすすめ）</label>
              <p className="mb-2 text-[11px] text-slate-500">
                報酬条件・承認条件・NGユーザー層・推奨KWは<strong>LPには載っていません</strong>。
                資料があればこちらの方が正確に埋まります。
              </p>
              <input
                ref={fileRef}
                type="file"
                accept=".pdf,.docx,.xlsx,.xlsm,.pptx"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void analyzeDocument(f);
                }}
              />
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className={btnAccent}
                  disabled={busy}
                  onClick={() => fileRef.current?.click()}
                >
                  {busy ? "読み取り中…" : "資料を選ぶ"}
                </button>
                <span className="text-[11px] text-slate-500">
                  PDF / Word / Excel / PowerPoint（32MBまで）
                </span>
              </div>
              <p className="mt-1.5 text-[11px] text-slate-400">
                PowerPoint は図の中の文字を読めません。PDF に書き出すと精度が上がります。
              </p>
            </div>

            <div className="flex items-center gap-2 text-[11px] text-slate-400">
              <span className="h-px flex-1 bg-slate-200" />
              または
              <span className="h-px flex-1 bg-slate-200" />
            </div>

            <div>
              <label className={labelCls}>商品LPのURL</label>
              <input
                value={inputUrl}
                onChange={(e) => setInputUrl(e.target.value)}
                className={inputCls}
                placeholder="https://example.com/lp"
                disabled={busy}
              />
            </div>
            <div>
              <label className={labelCls}>または 商品説明・キーワード（テキスト）</label>
              <textarea
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                rows={6}
                className={inputCls}
                placeholder={"例：法人向けの経費精算SaaS。月額500円/人。無料トライアルあり。\n想定KW：経費精算 システム 比較 など"}
                disabled={busy}
              />
            </div>
            <div className="flex items-center gap-3">
              <button type="button" onClick={analyze} disabled={busy} className={btnAccent}>
                {busy && (
                  <span className="mr-2 inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current/30 border-t-current" />
                )}
                {busy ? "AIが分析中…（数十秒かかります）" : "AIに分析させる"}
              </button>
              <span className="text-[11px] text-slate-400">LPの読み取りとキーワード提案を行います。</span>
            </div>
          </div>
        </Card>
      )}

      {step === 2 && draft && (
        <>
          {note && <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">{note}</p>}
          {docName && (
            <p className="rounded-md bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
              資料「{docName}」から読み取りました。案件作成後、この資料は案件に紐づいて保管されます。
            </p>
          )}
          <Card title="案件とキーワードの確認" desc="AIの提案です。修正してから作成できます。">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className={labelCls}>案件名</label>
                <input
                  value={draft.campaign_name}
                  onChange={(e) => setDraftField("campaign_name", e.target.value)}
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls}>クライアント名</label>
                <input
                  value={draft.client_name}
                  onChange={(e) => setDraftField("client_name", e.target.value)}
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls}>商材名</label>
                <input
                  value={draft.product_name}
                  onChange={(e) => setDraftField("product_name", e.target.value)}
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls}>成果地点</label>
                <input
                  value={draft.conversion_point}
                  onChange={(e) => setDraftField("conversion_point", e.target.value)}
                  className={inputCls}
                />
              </div>
              <div className="md:col-span-2">
                <label className={labelCls}>訴求ポイント・信用点</label>
                <textarea
                  value={draft.selling_points}
                  onChange={(e) => setDraftField("selling_points", e.target.value)}
                  rows={2}
                  className={inputCls}
                />
              </div>
            </div>

            <div className="mt-5">
              <label className={labelCls}>収集するキーワード（チェックした分だけ自動収集します）</label>
              <ul className="mt-1 grid gap-1.5 md:grid-cols-2">
                {kws.map((k, i) => (
                  <li key={i} className="flex items-center gap-2 rounded-lg bg-slate-50 px-3 py-2">
                    <input
                      type="checkbox"
                      checked={k.checked}
                      onChange={() =>
                        setKws((prev) => prev.map((x, j) => (j === i ? { ...x, checked: !x.checked } : x)))
                      }
                      disabled={busy}
                    />
                    <span className="text-sm text-slate-800">{k.keyword}</span>
                    <span className="ml-auto text-[10px] text-slate-400">優先度{k.priority}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-3">
              <button type="button" onClick={create} disabled={busy} className={btnAccent}>
                {busy && (
                  <span className="mr-2 inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current/30 border-t-current" />
                )}
                {busy ? "作成中…" : "この内容で作成して自動収集へ"}
              </button>
              <button type="button" onClick={() => setStep(1)} disabled={busy} className={btnGhost}>
                入力に戻る
              </button>
              <span className="text-[11px] text-slate-400">
                自動検索にはAPI利用料がかかります（1キーワードあたり数円〜十数円）。
              </span>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
