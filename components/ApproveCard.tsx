"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge, btnGhost, btnSmall, inputCls } from "@/components/ui";
import SubmitButton from "@/components/SubmitButton";

type Act = (formData: FormData) => void | Promise<void>;

export type QueueItem = {
  id: string;
  kind: string;
  rank: number | null;
  article_url: string;
  campaign_name: string;
  media_id: string;
  media_name: string;
  media_domain: string;
  asp_type: string;
  asp_name: string;
  no_solicitation: boolean;
  contact: string | null;
  contactKind: string | null;
  history: { at: string; label: string }[];
  subject: string;
  body: string;
};

export default function ApproveCard({
  item,
  approve,
  save,
  exclude,
}: {
  item: QueueItem;
  approve: Act;
  save: Act;
  exclude: Act;
}) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(item.body);
  const [subject, setSubject] = useState(item.subject);

  return (
    <article className="rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="grid gap-0 md:grid-cols-[280px_1fr]">
        {/* 左：メディア情報 */}
        <div className="border-b border-slate-100 p-4 md:border-b-0 md:border-r">
          <Link href={`/media/${item.media_id}`} className="font-bold text-[#1B2A4A] hover:underline">
            {item.media_name || item.media_domain}
          </Link>
          <div className="text-[11px] text-slate-400">{item.media_domain}</div>

          <div className="mt-2 flex flex-wrap gap-1">
            <Badge
              tone={item.kind === "replace" ? "bg-purple-100 text-purple-800" : "bg-slate-100 text-slate-700"}
            >
              {item.kind === "replace" ? "リプレイス打診" : "新規打診"}
            </Badge>
            <Badge>{item.asp_type === "asp" ? `ASP経由${item.asp_name ? `（${item.asp_name}）` : ""}` : "直接"}</Badge>
            {item.rank != null && <Badge>検索{item.rank}位</Badge>}
            {item.no_solicitation && <Badge tone="bg-red-100 text-red-700">営業お断り</Badge>}
          </div>

          <dl className="mt-3 space-y-1.5 text-[11px]">
            <div>
              <dt className="text-slate-400">案件</dt>
              <dd className="text-slate-700">{item.campaign_name}</dd>
            </div>
            <div>
              <dt className="text-slate-400">送信先</dt>
              <dd className="break-all text-slate-700">
                {item.contact ? `${item.contactKind === "mail" ? "メール" : item.contactKind === "dm" ? "DM" : "フォーム"}：${item.contact}` : "未設定（例外対応キューへ）"}
              </dd>
            </div>
            {item.article_url && (
              <div>
                <dt className="text-slate-400">対象記事</dt>
                <dd>
                  <a href={item.article_url} target="_blank" rel="noreferrer" className="text-sky-700 underline break-all">
                    {item.article_url}
                  </a>
                </dd>
              </div>
            )}
            <div>
              <dt className="text-slate-400">過去の接触</dt>
              <dd className="text-slate-700">
                {item.history.length === 0 ? (
                  "なし（初回）"
                ) : (
                  <ul className="space-y-0.5">
                    {item.history.slice(0, 4).map((h, i) => (
                      <li key={i}>
                        {h.at} — {h.label}
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
            </div>
          </dl>
        </div>

        {/* 右：文面 */}
        <div className="p-4">
          {editing ? (
            <form action={save} className="space-y-2">
              <input type="hidden" name="target_id" value={item.id} />
              <input
                name="subject"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                className={inputCls}
              />
              <textarea
                name="body"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                rows={14}
                className={`${inputCls} font-mono text-xs leading-relaxed`}
              />
              <div className="flex gap-2">
                <SubmitButton variant="accent">修正を保存</SubmitButton>
                <button type="button" onClick={() => setEditing(false)} className={btnGhost}>
                  取消
                </button>
              </div>
            </form>
          ) : (
            <>
              <div className="text-sm font-semibold text-slate-800">{item.subject}</div>
              <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs leading-relaxed text-slate-700">
                {item.body}
              </pre>
              <div className="mt-3 flex flex-wrap gap-2">
                <form action={approve} className="inline">
                  <input type="hidden" name="ids" value={item.id} />
                  <SubmitButton variant="accent">承認して送信キューへ</SubmitButton>
                </form>
                <button type="button" onClick={() => setEditing(true)} className={btnGhost}>
                  編集して承認
                </button>
                <form action={exclude} className="inline">
                  <input type="hidden" name="ids" value={item.id} />
                  <input type="hidden" name="status" value="excluded" />
                  <select name="reason" className={`${btnSmall} mr-1`} defaultValue="このメディアには打診しない">
                    <option>このメディアには打診しない</option>
                    <option>ランキング記事ではない</option>
                    <option>重複・名寄せ漏れ</option>
                    <option>営業お断りの記載あり</option>
                  </select>
                  <SubmitButton variant="ghost">除外</SubmitButton>
                </form>
              </div>
            </>
          )}
        </div>
      </div>
    </article>
  );
}
