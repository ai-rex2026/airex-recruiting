import { inflateRawSync } from "node:zlib";

/**
 * docx / xlsx / pptx からテキストを取り出す最小リーダー。
 * これらは中身が zip + XML なので、Node 標準の zlib だけで読める（依存を足さない）。
 * 図形・画像の中の文字は取れない点に注意（pptx はとくに落ちやすいので PDF 化を推奨する）。
 */

type Entry = { name: string; data: Uint8Array };

const dec = new TextDecoder("utf-8");

/** zip のセントラルディレクトリを辿って、必要なエントリだけ展開する */
function unzip(buf: Uint8Array, want: (name: string) => boolean): Entry[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  // EOCD を末尾から探す（コメント長は最大 65535）
  let eocd = -1;
  const from = Math.max(0, buf.length - 22 - 65535);
  for (let i = buf.length - 22; i >= from; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("ZIP_EOCD_NOT_FOUND");

  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true); // セントラルディレクトリ先頭

  const out: Entry[] = [];
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (!want(name)) continue;

    // ローカルヘッダは name/extra の長さが中央と異なりうるので、必ず読み直す
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    try {
      out.push({ name, data: method === 0 ? raw : inflateRawSync(raw) });
    } catch {
      // 壊れたエントリは飛ばす（1つの失敗で全体を落とさない）
    }
  }
  return out;
}

function xmlText(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  const out: string[] = [];
  for (const m of xml.matchAll(re)) {
    const t = m[1]
      .replace(/<[^>]+>/g, "")
      // 書き出し側によっては日本語が数値文字参照になる（openpyxl 等）
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      // &amp; は最後（&amp;#38917; を数値参照として誤解釈しないため）
      .replace(/&amp;/g, "&");
    if (t.trim()) out.push(t);
  }
  return out;
}

/** ファイル名順に並べる（slide2 が slide10 より先に来るよう数値で比較する） */
function byNumber(a: Entry, b: Entry): number {
  const n = (s: string) => Number(s.match(/(\d+)\.xml$/)?.[1] ?? 0);
  return n(a.name) - n(b.name);
}

function readDocx(buf: Uint8Array): string {
  const [doc] = unzip(buf, (n) => n === "word/document.xml");
  if (!doc) return "";
  const xml = dec.decode(doc.data);
  // 段落ごとに改行を入れたいので、まず段落で割る
  return xml
    .split(/<\/w:p>/)
    .map((p) => xmlText(p, "w:t").join(""))
    .filter((l) => l.trim())
    .join("\n");
}

function readPptx(buf: Uint8Array): string {
  const slides = unzip(buf, (n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(byNumber);
  return slides
    .map((s, i) => {
      const lines = xmlText(dec.decode(s.data), "a:t");
      return lines.length ? `--- スライド${i + 1} ---\n${lines.join("\n")}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function readXlsx(buf: Uint8Array): string {
  const files = unzip(
    buf,
    (n) => n === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet\d+\.xml$/.test(n)
  );
  const sharedRaw = files.find((f) => f.name === "xl/sharedStrings.xml");
  // sharedStrings は <si> 単位。中の <t> を連結して1件にする（リッチテキストで分割されるため）
  const shared = sharedRaw
    ? dec
        .decode(sharedRaw.data)
        .split(/<\/si>/)
        .map((si) => xmlText(si, "t").join(""))
    : [];

  const sheets = files.filter((f) => f.name.startsWith("xl/worksheets/")).sort(byNumber);
  return sheets
    .map((sheet, si) => {
      const xml = dec.decode(sheet.data);
      const rows: string[] = [];
      for (const row of xml.split(/<\/row>/)) {
        const cells: string[] = [];
        for (const m of row.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
          const attrs = m[1];
          const body = m[2];
          const type = attrs.match(/\st="([^"]+)"/)?.[1] ?? "";
          if (type === "s") {
            const idx = Number(xmlText(body, "v")[0] ?? -1);
            cells.push(shared[idx] ?? "");
          } else if (type === "inlineStr") {
            cells.push(xmlText(body, "t").join(""));
          } else {
            cells.push(xmlText(body, "v")[0] ?? "");
          }
        }
        const line = cells.join("\t").trim();
        if (line) rows.push(line);
      }
      return rows.length ? `--- シート${si + 1} ---\n${rows.join("\n")}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

export type OoxmlKind = "docx" | "xlsx" | "pptx";

/** 拡張子から形式を判定する。対応外なら null */
export function ooxmlKindOf(fileName: string): OoxmlKind | null {
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (ext === "docx") return "docx";
  if (ext === "xlsx" || ext === "xlsm") return "xlsx";
  if (ext === "pptx") return "pptx";
  return null;
}

/** OOXML ファイルからプレーンテキストを取り出す */
export function extractOoxmlText(buf: Uint8Array, kind: OoxmlKind, limit = 60000): string {
  const text =
    kind === "docx" ? readDocx(buf) : kind === "pptx" ? readPptx(buf) : readXlsx(buf);
  return text.replace(/\n{3,}/g, "\n\n").slice(0, limit);
}
