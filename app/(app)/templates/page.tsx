import { getSessionProfile } from "@/lib/supabase/server";
import { saveTemplate, deleteTemplate } from "@/app/actions";
import { Card, Empty, btnAccent, btnSmall, inputCls, labelCls } from "@/components/ui";

export const dynamic = "force-dynamic";

const VARS = [
  "{{メディア名}}",
  "{{サービス名}}",
  "{{単価}}",
  "{{成果地点}}",
  "{{承認条件}}",
  "{{信用点}}",
  "{{LP}}",
  "{{差出人}}",
  "{{署名}}",
];

export default async function TemplatesPage() {
  const { sb } = await getSessionProfile();
  const { data: templates } = await sb.from("templates").select("*").order("created_at");

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-bold text-[#1B2A4A]">文面テンプレート</h1>
        <p className="mt-1 text-xs text-slate-500">
          現行の実文面をテンプレート化します。AIはこれを土台に、メディアごとの文面を下書きします。
        </p>
      </header>

      <Card title="使える変数">
        <div className="flex flex-wrap gap-1.5">
          {VARS.map((v) => (
            <code key={v} className="rounded bg-slate-100 px-2 py-1 text-[11px] text-slate-700">
              {v}
            </code>
          ))}
        </div>
      </Card>

      {(templates ?? []).map((t) => (
        <Card key={t.id} title={t.name} desc={t.kind === "replace" ? "リプレイス打診用" : "新規打診用"}>
          <form action={saveTemplate} className="space-y-3">
            <input type="hidden" name="id" value={t.id} />
            <div className="grid gap-3 md:grid-cols-3">
              <div>
                <label className={labelCls}>テンプレート名</label>
                <input name="name" defaultValue={t.name} className={inputCls} />
              </div>
              <div>
                <label className={labelCls}>用途</label>
                <select name="kind" defaultValue={t.kind} className={inputCls}>
                  <option value="new">新規打診</option>
                  <option value="replace">リプレイス打診</option>
                </select>
              </div>
              <div>
                <label className={labelCls}>本文の文字数上限（任意）</label>
                <input name="max_chars" type="number" defaultValue={t.max_chars ?? ""} className={inputCls} />
              </div>
            </div>
            <div>
              <label className={labelCls}>件名</label>
              <input name="subject" defaultValue={t.subject} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>本文</label>
              <textarea name="body" defaultValue={t.body} rows={14} className={`${inputCls} font-mono text-xs`} />
            </div>
            <div className="flex gap-2">
              <button className={btnAccent}>保存</button>
            </div>
          </form>
          <form action={deleteTemplate} className="mt-2">
            <input type="hidden" name="id" value={t.id} />
            <button className={btnSmall}>このテンプレートを削除</button>
          </form>
        </Card>
      ))}

      {(templates ?? []).length === 0 && <Empty>テンプレートがありません。下から追加してください。</Empty>}

      <Card title="テンプレートを追加">
        <form action={saveTemplate} className="space-y-3">
          <div className="grid gap-3 md:grid-cols-3">
            <div>
              <label className={labelCls}>テンプレート名</label>
              <input name="name" required className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>用途</label>
              <select name="kind" className={inputCls}>
                <option value="new">新規打診</option>
                <option value="replace">リプレイス打診</option>
              </select>
            </div>
            <div>
              <label className={labelCls}>本文の文字数上限（任意）</label>
              <input name="max_chars" type="number" className={inputCls} placeholder="例：800" />
            </div>
          </div>
          <div>
            <label className={labelCls}>件名</label>
            <input name="subject" className={inputCls} placeholder="【掲載のご相談】{{サービス名}}" />
          </div>
          <div>
            <label className={labelCls}>本文</label>
            <textarea name="body" rows={8} required className={`${inputCls} font-mono text-xs`} />
          </div>
          <button className={btnAccent}>追加</button>
        </form>
      </Card>
    </div>
  );
}
