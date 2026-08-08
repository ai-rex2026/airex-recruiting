# AI-Rex Recruiting

広告リクルーティング業務（ランキング／比較メディアへの掲載獲得）を、
**AIが下書きし、人は承認するだけ**で回すオペレーション基盤。

要件定義書「広告リクルーティング業務 AI化アプリ 要件定義書 v0.1」に対応する実装です。

## 構成

- Next.js 16（App Router / Server Actions） / TypeScript / Tailwind CSS v4
- Supabase（PostgreSQL / Auth / RLS）
- Claude API（メディア判定・掲載判定・競合抽出・文面生成・返信分類・URL候補提案・Web検索による自動収集）
- Vercel

## 主な画面

| パス | 役割 |
|---|---|
| `/start` | **かんたん開始**。商品URL／テキスト → AIが案件・KWを提案 → Web検索で自動収集 → 陣取り表 |
| `/dashboard` | ファネル、到達率・返信率・掲載獲得率、直近の操作 |
| `/queue` | **承認キュー（中核）**。送信承認／返信の分類 |
| `/board` | 陣取りボード。KW × メディアの盤面。打診対象の確定 |
| `/collect` | 収集（業務①）。検索結果を貼り付け → AI判定 → 陣取り表 |
| `/media` `/media/[id]` | メディア台帳。名寄せ・統合・営業お断り・接触履歴 |
| `/outbox` | 送信キューと送信結果の分類 |
| `/exceptions` | 例外対応キュー（CAPTCHA／URL不正／フォーム不備／不確定／宛先なし） |
| `/replies` | 返信・交渉の経過 |
| `/placements` | 掲載登録と掲載完了報告 |
| `/reports/[campaignId]` | クライアント向け報告書（印刷／PDF保存） |
| `/templates` | 文面テンプレート（変数差し込み） |
| `/settings` | 送信モード・レート上限・ASPマスタ・差出人名義／署名 |
| `/audit` | 監査ログ |

## かんたん開始（/start）

商品のURL、または商品情報・キーワードのテキストを入れるだけで、
関連する比較サイト・ランキングサイト・おすすめサイトが自動で集まり、陣取り表が出来上がります。

1. **商品を教えてください** — LP URL または商品説明テキストを入力。AIがLPを読み取り、案件情報と検索キーワード（8〜12個）を提案
2. **案件とキーワードの確認** — 提案内容を人が修正・キーワードを取捨選択して案件を作成
3. **自動収集** — キーワードごとに Claude API の **Web検索ツール**（`web_search`）で検索上位のランキング／比較／おすすめ記事を特定し、`/collect` の貼り付け方式と同じ形（serp_snapshot → serp_entries → article_listings → outreach_targets）で陣取り表に反映

- SERP取得は Claude API の Web検索ツールを使用（**O-1 の暫定解**。商用SERP APIへの置き換え可能な構造は維持）
- 自動検索にはAPI利用料がかかります（1キーワードあたり数円〜十数円）
- 収集まで自動、**打診対象の確定・送信の承認は人が行います**（自動送信・自動承認はしません）

## 絶対に守る原則（コードで担保）

1. **二重送信しない** — 成功／不確定／営業お断り／手動送信済 の履歴がある打診は送信対象にしない（承認時・ワーカー取得時の両方でチェック）
2. **CAPTCHAは突破しない** — 例外対応キューへ退避
3. **営業お断りは尊重** — メディア単位でフラグを立て、以後の打診から自動除外。解除は管理者のみ
4. **マスタの書き換えは承認制** — AIのURL候補は「未検証」としてメモに残すだけで、台帳への反映は人が行う

## 環境変数

```
NEXT_PUBLIC_APP_URL
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
ANTHROPIC_API_KEY
WORKER_TOKEN      # 送信ワーカー連携（任意）
WORKER_EMAIL      # ワーカー用アカウント
WORKER_PASSWORD
```

## 送信ワーカー連携

送信そのものは外部の Playwright ワーカー（`form-outreach-runner`）が実行します。

```
GET  /api/worker/pull      Header: x-worker-token: <WORKER_TOKEN>
  → {"count":n,"items":[{"attempt_id","channel","to","media","domain","subject","body"}]}

POST /api/worker/report    Header: x-worker-token: <WORKER_TOKEN>
  Body: {"attempt_id":"...","result":"success|uncertain|form_error|url_error|captcha|no_solicitation",
         "detail":"...","evidence_path":"..."}
```

`result` の書き戻しは1回だけ受け付けます（2回目は 409）。

## 未実装・今後（要件定義書の未決事項に対応）

- SERP 取得 API 連携（O-1）— 暫定解として `/start` が Claude API の Web検索ツールで自動収集に対応。貼り付け入力（`/collect`）も併用可
- メール送受信基盤の統合（返信は現在、本文の貼り付けで取り込み）
- 掲載記事のスクリーンショット自動取得
- マルチテナント運用（スキーマは `tenant_id` 前提で設計済み、RLS 適用済み）

## セットアップ（別環境に立てる場合）

1. Supabase プロジェクトを作成し、`supabase/schema.sql` を適用
2. 環境変数を設定
3. `npm install && npm run build`
