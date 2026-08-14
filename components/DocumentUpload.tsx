"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { registerDocument, extractDocument, type DocKind } from "@/app/document-actions";
import { btnAccent, btnSmall } from "@/components/ui";

const ACCEPT = ".pdf,.docx,.xlsx,.xlsm,.pptx";
const MAX_BYTES = 32 * 1024 * 1024; // Anthropic に渡せる上限に合わせる

function extOk(name: string): boolean {
  return /\.(pdf|docx|xlsx|xlsm|pptx)$/i.test(name);
}

/**
 * 資料アップロード。ブラウザから Storage へ直接置き、パスだけをサーバーに渡す。
 * アップロード完了後、そのまま読み取り（抽出）まで走らせる。
 */
export default function DocumentUpload({
  kind,
  tenantId,
  campaignId,
  mediaId,
  label = "資料をアップロード",
}: {
  kind: DocKind;
  tenantId: string;
  campaignId?: string;
  mediaId?: string;
  label?: string;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (file: File) => {
    setError(null);

    if (!extOk(file.name)) {
      setError("PDF / Word(.docx) / Excel(.xlsx) / PowerPoint(.pptx) のいずれかを選んでください。");
      return;
    }
    if (file.size > MAX_BYTES) {
      setError(`ファイルが大きすぎます（上限32MB／このファイルは${Math.round(file.size / 1024 / 1024)}MB）。`);
      return;
    }

    try {
      setBusy("アップロード中…");
      const owner = campaignId ?? mediaId ?? "misc";
      // 先頭を tenant_id にする（Storage の RLS がこのセグメントで隔離している）
      const path = `${tenantId}/${kind}/${owner}/${crypto.randomUUID()}-${file.name}`;

      const sb = createClient();
      const up = await sb.storage.from("documents").upload(path, file, {
        contentType: file.type || "application/octet-stream",
        upsert: false,
      });
      if (up.error) throw new Error(`アップロードに失敗しました：${up.error.message}`);

      setBusy("登録中…");
      const reg = await registerDocument({
        kind,
        campaign_id: campaignId ?? null,
        media_id: mediaId ?? null,
        file_name: file.name,
        storage_path: path,
        mime_type: file.type || "",
        byte_size: file.size,
      });
      if (!reg.ok) throw new Error(reg.error);

      setBusy("AIが資料を読み取り中…（大きな資料は1分ほどかかります）");
      const ex = await extractDocument(reg.id);
      if (!ex.ok) setError(ex.error);

      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました。");
    } finally {
      setBusy(null);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void run(f);
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={campaignId || mediaId ? btnSmall : btnAccent}
          disabled={!!busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ?? label}
        </button>
        <span className="text-[11px] text-slate-500">
          PDF / Word / Excel / PowerPoint（32MBまで）
        </span>
      </div>
      <p className="text-[11px] text-slate-400">
        PowerPoint は図形や画像の中の文字を読み取れません。
        <strong className="text-slate-500">PDF に書き出してからアップロードすると精度が上がります。</strong>
      </p>
      {error && (
        <p className="rounded border border-red-200 bg-red-50 px-2 py-1.5 text-[11px] text-red-700">
          {error}
        </p>
      )}
    </div>
  );
}
