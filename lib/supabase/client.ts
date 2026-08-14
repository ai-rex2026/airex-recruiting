import { createBrowserClient } from "@supabase/ssr";

/**
 * ブラウザ用クライアント。資料ファイルを Storage へ直接アップロードするために使う。
 * Server Actions は既定 1MB、Vercel のサーバーレスはボディ 4.5MB が上限で、
 * 数MB〜数十MBの営業資料PDFはサーバー経由では通らないため。
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
