/**
 * Supabase Storage のオブジェクトキーは非ASCII文字を受け付けない（日本語ファイル名で Invalid key になる）。
 * そのため保存先のキーは英数字だけで組み、元のファイル名は documents.file_name に持たせる。
 * 画面表示も「出典：〜」の表記も file_name を使うので、日本語のファイル名は失われない。
 */

/** 拡張子だけを安全な形で取り出す（無ければ空文字） */
function safeExt(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot < 0) return "";
  const ext = fileName
    .slice(dot + 1)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 8);
  return ext ? `.${ext}` : "";
}

/**
 * 資料の保存先キーを組む。
 * 先頭セグメントは必ず tenantId（Storage の RLS がここでテナントを隔離しているため）。
 */
export function documentStorageKey(
  tenantId: string,
  kind: string,
  owner: string,
  fileName: string,
  uuid: string
): string {
  return `${tenantId}/${kind}/${owner}/${uuid}${safeExt(fileName)}`;
}
