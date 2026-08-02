"use client";

import { useActionState } from "react";
import { signIn } from "@/app/actions";
import { btnPrimary, inputCls, labelCls } from "@/components/ui";

export default function LoginPage() {
  const [state, action, pending] = useActionState(signIn, null as { error?: string } | null);

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6">
          <p className="text-xs font-bold tracking-wide text-[#C1553B]">AI-Rex Recruiting</p>
          <h1 className="mt-1 text-2xl font-bold text-[#1B2A4A]">
            広告リクルーティング
            <br />
            オペレーション基盤
          </h1>
          <p className="mt-2 text-xs text-slate-500">
            AIが下書きし、人は承認するだけ。
          </p>
        </div>

        <form action={action} className="space-y-4 rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
          <div>
            <label className={labelCls}>メールアドレス</label>
            <input name="email" type="email" required className={inputCls} autoComplete="email" />
          </div>
          <div>
            <label className={labelCls}>パスワード</label>
            <input
              name="password"
              type="password"
              required
              className={inputCls}
              autoComplete="current-password"
            />
          </div>
          {state?.error && (
            <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700">{state.error}</p>
          )}
          <button type="submit" disabled={pending} className={`${btnPrimary} w-full`}>
            {pending ? "確認中…" : "ログイン"}
          </button>
        </form>
      </div>
    </main>
  );
}
