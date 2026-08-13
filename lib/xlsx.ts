/**
 * 依存なしの最小 xlsx ライター。
 * 行数が数百規模なので圧縮なし（store）の ZIP で十分。文字列は inlineStr で埋め、
 * sharedStrings を省いている。
 */

export type XlsxCell = { v: string | number | null; s?: number };

export type XlsxSheet = {
  name: string;
  /** 列幅（文字数）。ヘッダーと同じ数だけ渡す */
  cols: number[];
  rows: XlsxCell[][];
  /** 表の見出し行（0始まり）。ここまでを固定し、ここからオートフィルタを張る。既定は先頭行 */
  headerRow?: number;
  /** 結合セル。"A1:W1" の形式 */
  merges?: string[];
  /** 行の高さ（0始まりの行インデックス → ポイント） */
  rowHeights?: Record<number, number>;
};

/** styles.xml の cellXfs のインデックス。呼び出し側はこれを XlsxCell.s に渡す */
export const XS = {
  base: 0,
  header: 1,
  text: 2,
  num: 3,
  own: 4,
  link: 5,
  muted: 6,
  /** 順位なし行：グレー地＋斜体で、順位あり行と見分けられるようにする */
  dim: 7,
  dimNum: 8,
  /** 案件カルテのヘッダーブロック用 */
  briefTitle: 9,
  briefLabel: 10,
  briefValue: 11,
  brief: 12,
} as const;

const enc = new TextEncoder();

let CRC_TABLE: Uint32Array | null = null;
function crcTable(): Uint32Array {
  if (CRC_TABLE) return CRC_TABLE;
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  CRC_TABLE = t;
  return t;
}

function crc32(buf: Uint8Array): number {
  const t = crcTable();
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // 制御文字は OOXML では不正なので落とす
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
}

/** 0始まりの列インデックスを A, B, … AA の形にする（結合セルの指定でも使う） */
export function colName(i: number): string {
  let n = i + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function zipStore(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const now = new Date();
  const dosTime =
    (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const dosDate =
    ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = enc.encode(f.name);
    const crc = crc32(f.data);

    const local = new Uint8Array(30 + nameBuf.length + f.data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0, true); // flags
    lv.setUint16(8, 0, true); // method: store
    lv.setUint16(10, dosTime, true);
    lv.setUint16(12, dosDate, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, f.data.length, true);
    lv.setUint32(22, f.data.length, true);
    lv.setUint16(26, nameBuf.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBuf, 30);
    local.set(f.data, 30 + nameBuf.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBuf.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true);
    cv.setUint16(14, dosDate, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, f.data.length, true);
    cv.setUint32(24, f.data.length, true);
    cv.setUint16(28, nameBuf.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBuf, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((a, b) => a + b.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const total =
    locals.reduce((a, b) => a + b.length, 0) + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const b of [...locals, ...centrals, eocd]) {
    out.set(b, p);
    p += b.length;
  }
  return out;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="7">
<font><sz val="11"/><name val="游ゴシック"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="游ゴシック"/></font>
<font><b/><sz val="11"/><color rgb="FFC1553B"/><name val="游ゴシック"/></font>
<font><u/><sz val="11"/><color rgb="FF1155CC"/><name val="游ゴシック"/></font>
<font><sz val="11"/><color rgb="FF94A3B8"/><name val="游ゴシック"/></font>
<font><i/><sz val="11"/><color rgb="FF64748B"/><name val="游ゴシック"/></font>
<font><b/><sz val="11"/><color rgb="FF1B2A4A"/><name val="游ゴシック"/></font>
</fonts>
<fills count="6">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1B2A4A"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFDECE8"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFF1F5F9"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFDF0E6"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFD9DEE7"/></left><right style="thin"><color rgb="FFD9DEE7"/></right><top style="thin"><color rgb="FFD9DEE7"/></top><bottom style="thin"><color rgb="FFD9DEE7"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="13">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="4" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="5" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="5" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
<xf numFmtId="0" fontId="6" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="top" wrapText="1"/></xf>
</cellXfs>
</styleSheet>`;

function sheetXml(sheet: XlsxSheet, first: boolean): string {
  // 実データの最大列幅で dimension を決める（列定義より多い行があっても壊れないように）
  const nCols = Math.max(sheet.cols.length, ...sheet.rows.map((r) => r.length), 1);
  const lastCol = colName(nCols - 1);
  const headerRow = sheet.headerRow ?? 0;
  const cols = sheet.cols
    .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
    .join("");

  const rows = sheet.rows
    .map((cells, ri) => {
      const r = ri + 1;
      const cs = cells
        .map((c, ci) => {
          const ref = `${colName(ci)}${r}`;
          const s = c.s ?? 0;
          if (c.v === null || c.v === "") return `<c r="${ref}" s="${s}"/>`;
          if (typeof c.v === "number")
            return `<c r="${ref}" s="${s}"><v>${c.v}</v></c>`;
          return `<c r="${ref}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${esc(
            c.v
          )}</t></is></c>`;
        })
        .join("");
      const h = sheet.rowHeights?.[ri] ?? (ri === headerRow ? 26 : undefined);
      const attrs = h ? ` ht="${h}" customHeight="1"` : "";
      return `<row r="${r}"${attrs}>${cs}</row>`;
    })
    .join("");

  const lastRow = Math.max(sheet.rows.length, headerRow + 1);
  // 見出し行までを固定し、オートフィルタも見出し行から張る（上に案件カルテを積んでもズレないように）
  const freezeAt = headerRow + 2;
  const filterRef = `A${headerRow + 1}:${lastCol}${lastRow}`;
  const mergeXml = sheet.merges?.length
    ? `<mergeCells count="${sheet.merges.length}">${sheet.merges
        .map((m) => `<mergeCell ref="${m}"/>`)
        .join("")}</mergeCells>`
    : "";

  // 要素の順序は CT_Worksheet の定義どおり（sheetData → autoFilter → mergeCells）
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:${lastCol}${lastRow}"/>
<sheetViews><sheetView${first ? ' tabSelected="1"' : ""} workbookViewId="0"><pane ySplit="${headerRow + 1}" topLeftCell="A${freezeAt}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A${freezeAt}" sqref="A${freezeAt}"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="18"/>
<cols>${cols}</cols>
<sheetData>${rows}</sheetData>
<autoFilter ref="${filterRef}"/>
${mergeXml}</worksheet>`;
}

/** Excel のシート名に使えない文字を落とし、31文字に収める */
function sheetName(raw: string, i: number): string {
  const s = raw.replace(/[\\/:*?[\]]/g, "_").slice(0, 31);
  return esc(s || `Sheet${i + 1}`);
}

/** 複数シートの .xlsx バイト列を組み立てる */
export function buildXlsx(sheets: XlsxSheet[]): Uint8Array {
  const list = sheets.length ? sheets : [{ name: "Sheet1", cols: [], rows: [] }];
  // styles は末尾の rId を使い、シートぶんの rId1..N と衝突させない
  const stylesRid = `rId${list.length + 1}`;

  const files: { name: string; data: Uint8Array }[] = [
    {
      name: "[Content_Types].xml",
      data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${list
  .map(
    (_, i) =>
      `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  )
  .join("\n")}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`),
    },
    {
      name: "_rels/.rels",
      data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    },
    {
      name: "xl/workbook.xml",
      data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${list
        .map(
          (s, i) =>
            `<sheet name="${sheetName(s.name, i)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
        )
        .join("")}</sheets>
</workbook>`),
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: enc.encode(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${list
  .map(
    (_, i) =>
      `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
  )
  .join("\n")}
<Relationship Id="${stylesRid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`),
    },
    { name: "xl/styles.xml", data: enc.encode(STYLES) },
    ...list.map((s, i) => ({
      name: `xl/worksheets/sheet${i + 1}.xml`,
      data: enc.encode(sheetXml(s, i === 0)),
    })),
  ];
  return zipStore(files);
}

/** Excel が UTF-8 と判別できるよう BOM 付きで返す */
export function buildCsv(rows: (string | number | null)[][]): Uint8Array {
  const body = rows
    .map((r) =>
      r
        .map((c) => {
          const s = c === null || c === undefined ? "" : String(c);
          return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(",")
    )
    .join("\r\n");
  return enc.encode(`﻿${body}\r\n`);
}
