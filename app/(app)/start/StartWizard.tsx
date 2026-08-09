"use client";

import { useState } from "react";
import { Card, btnAccent, btnGhost, inputCls, labelCls } from "@/components/ui";
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
}: {
  onCreated: (campaignId: string, jobs: RunnableJob[]) => void;
}) {
  const [step, setStep] = useState<1 | 2>(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Step1
  const [inputUrl, setInputUrl] = useState("");
  const [inputText, setInputText] = useState("");

  // Step2
  const [draft, setDraft] = useState<CampaignDraft | null>(null);
  const [kws, setKws] = useState<KwRow[]>([]);

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
          desc="商品LPのURL、または商品説明・キーワードのテキスト。どちらか一方でOKです。"
        >
          <div className="space-y-4">
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
