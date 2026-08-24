# RepoBD 要件レビューガイド（日本語） — 参考資料 / SUPERSEDED

> **この文書は正本ではありません。**
>
> 本書は Phase 4 実装以前の要件レビュー時点で作成された **日本語の参考資料** です。
> 現在の実装・product boundary・governance とは複数の点で一致しません。
>
> **本書を実装手順・レビュー手順・governance rule として参照しないでください。**
> 判断が必要な場合は必ず下記の英語正本を参照してください。

## 現在の正本

| 対象 | 正本 |
|---|---|
| 現在の checkpoint / phase 状態 / 未解決事項 | [`../HANDOVER.md`](../HANDOVER.md) |
| v0.1 product behavior / scope | [`MVP_REQUIREMENTS.md`](MVP_REQUIREMENTS.md) |
| Security invariants | [`SECURITY_INVARIANTS.md`](SECURITY_INVARIANTS.md) |
| Threat boundary | [`THREAT_MODEL.md`](THREAT_MODEL.md) |
| Architecture | [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| Phase 計画 / 実装順序 | [`IMPLEMENTATION_PLAN.md`](IMPLEMENTATION_PLAN.md) |
| **AI workflow / review / authorization gate** | [`AI_WORKFLOW.md`](AI_WORKFLOW.md) |
| Agent 全般の routing / 禁止事項 | [`../AGENTS.md`](../AGENTS.md) |

## 本書の記述のうち、特に現行と異なる点

以下は本書の本文より **英語正本が優先** します。本文は当時の記録として残しています。

- **Payload** — 1 delivery = 厳密に 1 つの `KEY=value`。複数 assignment は fail closed。
  `.env` 全文や任意テキストの受け渡しは v0.1 の対象外です。
- **Target** — 検証済み Git worktree root の `.env` のみ。`.env.local` 等の
  複数 target 候補や target 選択 UI は v0.1 では実装されません。
- **Mapping / 候補提示** — v0.1 では実装しません。variable name は payload 内に
  含まれるため推測は不要です。本文 §8 の候補提示 UI は現行の動作ではありません。
- **Environment metadata** — 現行実装には channel 自体が存在しません（本文 §7）。
  eventual v0.1 リリース前に追加するかどうかは Phase 5 の未決事項であり、
  決定事項ではありません。
- **Sender / Web 送信画面** — `repobd send` は未完成です。Web 送信面を MVP に
  含めるかどうかを含め、Phase 5 の未決事項であり、決定事項ではありません。
- **開発時の役割分担（本文 §14 / §15）** — 現行の governance に置き換えられています。
  下記「現行 governance」を参照してください。

## 現行 governance（要約 / 正本は `AI_WORKFLOW.md`）

本書本文の記述と異なり、現在は以下が厳格に適用されます。

1. 1 つの repository/worktree に対して **ACTIVE な AI agent は常に 1 つだけ**です。
   read-only の調査も active work として扱われます。
2. Claude Code は承認された cycle を実装・validation したのち Codex へ review を
   送り、**その時点で IDLE** になります。review 中は repository 作業を一切行わず、
   結果を polling もしません。
3. Codex は read-only で review し、結果を **自身の pane で Human へ報告**します。
   結果が Claude Code へ自動的に返ることはありません。
4. **Codex の指摘は自動修正されません。** severity を問わず、修正には毎回
   Human の明示的な承認が必要です。
5. commit / push / deploy / npm publish / security boundary 変更は Human 承認事項です。


---

## 1. RepoBD の目的

RepoBD は Secret Manager ではありません。

目的は、API key、`.env`、password などの Secret を、意図した開発 context に安全に渡し、誤った repository への適用を機械的に止めることです。

中心となる考え方は以下です。

- Secret を安全に渡す
- Secret を正しい repo にだけ適用する
- 人間の目視・記憶に依存する確認を減らす
- 既存の Secret Manager を置き換えない
- AI 専用ツールにしない。人→人、人→自分、人→AI 開発環境の handoff を扱う

タグライン候補は `Wrong repo. No secret.` です。

---

## 2. v0.1 の基本フロー

### Sender

1. `repobd send` または Web 送信画面を開く
2. Secret テキストを入力する
3. 対象 repo を指定する
4. 必要なら environment / target を指定する
5. TTL を指定する
6. ブラウザまたはローカルクライアント内で暗号化する
7. Server には ciphertext と非機密 metadata だけ保存する
8. short-lived な delivery URL を発行する

### Receiver

1. 対象 repo の Terminal で `repobd pull` を実行する
2. delivery URL を CLI prompt に貼る
3. CLI が現在の Git repo と `origin` を確認する
4. repo identity を正規化して比較する
5. 不一致なら BLOCK。write もしない、consume もしない
6. 一致した場合だけ environment / target / mapping 候補を表示する
7. ユーザーが確認する
8. ローカルで復号する
9. 許可された target に安全に書き込む
10. write 成功を確認した後に remote secret を consume する

RepoBD は commit / push / merge / deploy / 任意コマンド実行を行いません。

---

## 3. v0.1 で扱う payload

- plaintext text のみ
- 最大 64 KiB
- file upload なし
- `.env` 専用にはしない

将来的には API key、`.env`、password、Wi-Fi password、短い機密情報なども技術的には扱えるようにする余地を残します。

ただし v0.1 の表向きの主目的は developer secret handoff です。

---

## 4. 最重要 Security Invariants

以下は将来も原則として破ってはいけません。

1. Server は plaintext secret を受信しない
2. Server は plaintext secret を復号しない
3. Server は plaintext secret を保存しない
4. Server は plaintext secret を log に残さない
5. 独自暗号を実装しない
6. mismatch 時は write しない
7. successful apply 前に remote secret を consume しない
8. CLI は Secret 値を stdout / log に表示しない
9. repo 外へ書き込まない
10. path traversal / symlink を拒否する
11. git commit / push を行わない
12. 任意 shell command を実行しない

原則:

> The server must never receive, decrypt, inspect, log, or persist plaintext secret content.

> RepoBD protects the handoff, not the content.

---

## 5. Threat Model

### 守る対象

- 別 repo への Secret 誤投入
- Secret handoff 時の不用意な plaintext 共有
- expired / consumed Secret の再利用
- path / target の誤り
- Secret の log / stdout 露出

### 守らない対象

- OS 自体が侵害されている
- 悪意ある local user
- `.git/config` を意図的に改ざんする攻撃者
- 改ざんされた CLI
- compromised development machine
- Git repo の中身そのものが異常な状態

Repo identity check は local attacker に対する authentication boundary ではなく、accidental misuse 防止の guardrail と位置づけます。

---

## 6. Repo 判定

MVP では Git の `origin` remote を machine-readable な事実として使います。

例:

- `git@github.com:example/app.git`
- `https://github.com/example/app.git`

内部で `github.com/example/app` のように正規化して比較します。

folder 名や absolute path は repo identity として使用しません。

branch も v0.1 の hard check 対象にはしません。

理由:

- sender が receiver の作業 branch を知っているとは限らない
- feature / develop branch でも同じ project の Secret を使うことがある
- RepoBD は receiver の開発 workflow まで拘束しない

---

## 7. Environment の扱い

Git には production / staging / preview の標準的な machine-readable identity がありません。

そのため v0.1 では environment を無理に自動推定しません。

方針:

- repo = hard check
- environment = metadata として明示
- target = sender 指定または receiver 側で候補提示
- production 等は confirmation を強める

原則:

> RepoBD should automate only what it can determine reliably.

machine guesswork で human uncertainty を置き換えないことを優先します。

---

## 8. Secret の適用先候補

裸の API key が渡された場合、RepoBD はローカル repo に存在する事実だけを探して候補を出します。

優先対象例:

- `.env.example`
- `.env.sample`
- `.env.template`
- `process.env.X`
- `import.meta.env.X`
- README 内の環境変数名

例:

```
Secret detected:
Stripe secret key

Found in repository:
STRIPE_SECRET_KEY

Suggested target:
.env.local

Apply? [Y/n]
```

候補が複数なら選択させます。
候補がなければ手入力します。

推測結果を断定しないことが重要です。

`.env` 全文の場合は既に variable name が含まれているため、勝手に rename しません。

---

## 9. No / Cancel 時の原則

ユーザーが Apply を拒否した場合:

- local write しない
- local plaintext / temporary data を破棄する
- remote ciphertext は consume しない
- TTL 内なら再試行可能

ただし再試行して同じ候補しか出ない UX は避けます。

そのため target / variable mapping が違う場合は、候補変更・manual input へ進める設計にします。

---

## 10. Error handling

基本原則:

> Fail closed locally, retry safely remotely.

エラー時は:

- local write を止める
- plaintext / temporary data を破棄する
- successful apply までは remote secret を consume しない

例外:

- expired
- already consumed
- invalid token

など、remote 側で既に利用不能なものは再試行不可です。

---

## 11. Abuse 対策

RepoBD は server-side で Secret の中身を検査しません。

理由:

- server が plaintext を見ないという原則を崩すため

対策は利用挙動と metadata に限定します。

- 64 KiB 上限
- short TTL
- rate limiting
- WAF
- 大量作成制限
- brute-force 対策
- manual invalidation
- abuse / security contact

メール:

- `security@repobd.com`
- `abuse@repobd.com`

---

## 12. 技術スタック（v0.1 方針）

### Web / API / Infra

- Cloudflare Registrar
- Cloudflare DNS
- Cloudflare Workers
- Cloudflare D1
- Cloudflare rate limiting / WAF
- Cloudflare Email Routing

### CLI

- Node.js
- TypeScript
- npm package: `repobd`

### Crypto

- Web Crypto API
- AES-GCM 系の標準暗号 primitive
- 独自 crypto 禁止

### 推奨 dependency

- Commander: CLI command parsing
- `@clack/prompts`: CLI prompt / confirm / select
- `open`: browser launch
- `dotenv`: `.env` parsing

### 原則として使わない

- ORM
- 独自 crypto library
- Git abstraction library
- GitHub SDK
- dependency injection framework
- 過剰な state management
- AI による Secret server-side classification

---

## 13. Build / Native / Dependency 方針

RepoBD 自身の開発にも「簡単で間違わない」を適用します。

優先順位:

1. Security invariant を守れるか
2. そもそも作る必要があるか
3. 既存コードで済むか
4. stdlib で済むか
5. platform native で済むか
6. installed dependency で済むか
7. mature dependency を使う方が安全か
8. それでも必要なら最小実装

Ponytail / YAGNI の思想を採用します。

ただし以下は削減対象外です。

- security validation
- trust-boundary validation
- error handling
- data-loss prevention
- test

---

## 14. Herdr 開発構成 — SUPERSEDED

> 本節は当時の記録です。現行の pane 構成・model 方針・role 分担は
> [`../HERDR_BOOTSTRAP.md`](../HERDR_BOOTSTRAP.md) と
> [`AI_WORKFLOW.md`](AI_WORKFLOW.md) が正本です。

推奨 4 ペイン:

```
Claude Code            | Codex
Sonnet 5               | gpt-5.6-sol / High
Implementer             | Read-only reviewer
------------------------+------------------------
Test terminal           | Runtime terminal
Vitest / typecheck      | wrangler dev / D1
AI 常駐なし              | AI 常駐なし
```

model 昇格の考え方（crypto flow / secret lifecycle / filesystem write /
race condition / trust boundary で上位 model を用いる）は現在も同様ですが、
正確な条件は上記正本を参照してください。

---

## 15. 開発時の役割分担 — SUPERSEDED

> **本節の記述は現行 governance と一致しません。**
> 正本は [`AI_WORKFLOW.md`](AI_WORKFLOW.md) です。冒頭の「現行 governance」も
> 参照してください。
>
> 特に、当時の本文には次の 2 点の誤りがあります。
>
> - Claude Code の役割として「Codex 指摘修正」を無条件に挙げていました。
>   現在は、**severity を問わず Human の明示的承認なしに修正を開始しません。**
> - 「並列化するのは実装・レビュー・テスト・runtime」と記していました。
>   現在は、**同一 worktree に対して実装と review が同時に active になることは
>   ありません。** Claude Code が IDLE になってから Codex が review します。
>   並列なのは pane の存在であって、repository 作業ではありません。

現行の役割分担（要約）:

Claude Code:
- 承認された cycle 内での実装計画・実装
- test / typecheck / build（lint ツールは未導入。YAGNI に従い必要になるまで追加しない）
- validation 完了後に Codex へ review を送信し、IDLE になる

Codex:
- read-only independent review
- requirement drift / over-engineering / security invariant
- path / crypto / consume / logging 等の確認
- 結果は自身の pane で Human へ報告する

User:
- 重要判断
- commit / push / deploy / publish の承認
- Codex 指摘を受けた次の write cycle の承認

---

## 16. v0.1 で作らないもの

- User account
- Team / Organization
- RBAC
- SSO / SCIM
- Audit dashboard
- billing
- Vault
- Secret rotation
- GitHub App
- GitLab App
- IDE plugin
- MCP
- Kubernetes integration
- enterprise policy
- AI Secret Manager

RepoBD は Enterprise Secret Management platform を目指しません。

---

## 17. MVP 完成条件

最低限以下が成立すること。

- 正しい repo → apply 成功
- 間違った repo → BLOCK
- expired → BLOCK
- consumed → BLOCK
- 2回目 pull → BLOCK
- Secret は server で plaintext にならない
- decrypt key / plaintext が server log に残らない
- CLI stdout に Secret を出さない
- repo 外 write 不可
- path traversal 拒否
- symlink 拒否
- 64 KiB 超過拒否
- failed write 時に consume しない
- successful write 後のみ consume

---

## 18. 最初の検証対象

本番案件では試しません。

専用 test repo を使います。

例:

- `repobd/test-alpha`
- `repobd/test-beta`

Dummy Secret のみ使用します。

例:

```env
API_KEY=TEST_ALPHA_123456
```

最も重要な体験:

```
Alpha 用 Secret
↓
Beta repo で pull
↓
Wrong repo. No secret.
```

外部ユーザーによる MVP 検証では、vibe coder / AI coding 初中級者を中心に「manual copy より面倒ではないか」「実際に認知負荷が下がるか」を見ます。

---

## 19. Human review で特に確認したい点

実装開始前に、以下だけはユーザーが確認してください。

1. RepoBD の目的が Secret Manager 化していないか
2. Server が plaintext を一切見ない原則に例外がないか
3. repo mismatch 時に Secret が取得・消費されないか
4. environment を無理に machine guess していないか
5. CLI が commit / push / deploy を行わないか
6. Error 時に remote Secret を不用意に消さないか
7. dependency が増えすぎていないか
8. Cloudflare / D1 の設計が MVP に十分小さいか
9. v0.1 で不要な Team / Enterprise 機能が入っていないか

この 9 点は当時の観点の記録であり、現在の判断を免除するものではありません。
現在何が決定事項で何が未決事項かは、この 9 点の納得度にかかわらず、必ず本書冒頭
「現在の正本」に挙げた英語文書（特に `MVP_REQUIREMENTS.md` / `HANDOVER.md` /
`AI_WORKFLOW.md`）で確認してください。
