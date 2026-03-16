<p align="center">
  <img src="./apps/desktop/src-tauri/icons/icon.png" width="120" height="120" alt="ClaudePrism" />
</p>

<h1 align="center">ClaudePrism</h1>

<p align="center">
  Claude を活用した、オフラインファーストの論文執筆ワークスペース。<br/>
  LaTeX + Python + 100 以上の専門スキル ── デスクトップで動作します。
</p>

<p align="center">
  <a href="./README.md">English</a> ·
  <a href="./README.ko.md">한국어</a> ·
  <a href="./README.ja.md">日本語</a> ·
  <a href="./README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <img src="./assets/demo/main.webp" alt="ClaudePrism デモ" width="800" />
</p>

<p align="center">
  <a href="https://claudeprism.delibae.dev?utm_source=github&utm_medium=readme&utm_campaign=launch_v054">
    <img src="https://img.shields.io/badge/Website-claudeprism.dev-blue?style=flat-square&logo=googlechrome&logoColor=white" alt="Website" />
  </a>&nbsp;
  <a href="https://github.com/delibae/claude-prism/releases/latest/download/ClaudePrism_1.0.0_aarch64.dmg">
    <img src="https://img.shields.io/badge/Download-macOS_(Apple_Silicon)-black?style=for-the-badge&logo=apple&logoColor=white" alt="macOS 版をダウンロード" />
  </a>&nbsp;
  <a href="https://github.com/delibae/claude-prism/releases/latest/download/ClaudePrism_1.0.0_x64-setup.exe">
    <img src="https://img.shields.io/badge/Download-Windows-0078D4?style=for-the-badge&logo=windows&logoColor=white" alt="Windows 版をダウンロード" />
  </a>&nbsp;
  <a href="https://github.com/delibae/claude-prism/releases/latest/download/ClaudePrism_1.0.0_amd64.deb">
    <img src="https://img.shields.io/badge/Download-Linux_(deb)-FCC624?style=for-the-badge&logo=linux&logoColor=black" alt="Linux 版をダウンロード" />
  </a>
</p>
<p align="center">
  <a href="https://github.com/delibae/claude-prism/releases">
    <img src="https://img.shields.io/github/v/release/delibae/claude-prism?style=flat-square&label=Latest%20Release&color=green" alt="Latest Release" />
  </a>
</p>

---

## なぜ ClaudePrism なのか

[OpenAI Prism](https://openai.com/prism/) はクラウドベースの LaTeX ワークスペースです — 利用するにはすべてのファイルとデータを OpenAI のサーバーにアップロードする必要があります。

ClaudePrism は**ローカルファースト**の代替ツールです — ファイルはローカルディスクに保存し、オフラインでコンパイルします。AI 機能は Anthropic API にコンテンツを送信して推論を行います（[データ使用ポリシー](https://code.claude.com/docs/en/data-usage)を参照）。

| | OpenAI Prism | ClaudePrism |
|---|:---:|:---:|
| AI モデル | GPT-5.2 | **Claude Opus / Sonnet / Haiku** |
| 実行環境 | ブラウザ（クラウド） | **ネイティブデスクトップ（Tauri 2 + Rust）** |
| LaTeX | クラウドコンパイル | **Tectonic 内蔵（オフライン対応）** |
| Python 環境 | — | **uv + venv 内蔵 ── ワンクリックで科学計算向け Python 環境を構築** |
| 専門スキル | — | **100 以上の専門スキル（バイオインフォマティクス、ケモインフォマティクス、ML など）** |
| 導入 | アカウント設定が必要 | **インストール後すぐに利用可能 ── テンプレートギャラリー + プロジェクトウィザード** |
| バージョン管理 | — | **Git ベースの履歴管理（ラベル & diff）** |
| ソースコード | プロプライエタリ | **オープンソース（MIT）** |

### データとプライバシー

ドキュメントはローカルで保存・コンパイルされ、リモートサーバーにアップロードされません。ただし、AI 機能を使用する際、**プロンプトと Claude が読み取ったファイル内容は Anthropic API に送信されます**。これはすべてのクラウドベース LLM ツールと同様です。保持ポリシーとオプトアウトオプションについては [Claude Code データ使用ポリシー](https://code.claude.com/docs/en/data-usage)をご覧ください。

---

## 機能

### Python 環境（uv）

ClaudePrism には、高速な Python パッケージマネージャである [uv](https://docs.astral.sh/uv/) が直接組み込まれています。ワンクリックで uv をインストールし、ワンクリックでプロジェクトごとの仮想環境を作成できます。Claude Code は Python コードの実行時に `.venv` を自動で使用するため、エディタを離れることなく、グラフの生成、解析スクリプトの実行、データ処理を行えます。

<p align="center">
  <img src="./assets/demo/python.webp" alt="Python 環境" width="600" />
</p>

### 100 以上の専門スキル

[K-Dense Scientific Skills](https://github.com/K-Dense-AI/claude-scientific-skills) から、分野ごとのスキルを閲覧・インストールできます。これらは、Claude に各分野の専門知識を追加するための厳選されたプロンプトとツール設定です。

| 分野 | スキル |
|--------|--------|
| **バイオインフォマティクス & ゲノミクス** | Scanpy, BioPython, PyDESeq2, PySAM, gget, AnnData, ... |
| **ケモインフォマティクス & 創薬** | RDKit, DeepChem, DiffDock, PubChem, ChEMBL, ... |
| **データ分析 & 可視化** | Matplotlib, Seaborn, Plotly, Polars, scikit-learn, ... |
| **機械学習 & AI** | PyTorch Lightning, Transformers, SHAP, UMAP, PyMC, ... |
| **臨床研究** | ClinicalTrials.gov, ClinVar, DrugBank, FDA, ... |
| **研究支援** | 文献レビュー、研究費申請書の作成、引用管理, ... |
| **マルチオミクス & システム生物学** | scvi-tools, COBRApy, Reactome, Bioservices, ... |
| **その他** | 材料科学、ラボ自動化、プロテオミクス、物理学, ... |

スキルはグローバル（`~/.claude/skills/`）またはプロジェクト単位でインストールでき、必要に応じて Claude が自動的に読み込みます。

<p align="center">
  <img src="./assets/demo/scientific.webp" alt="専門スキル" width="700" />
</p>

### テンプレート & プロジェクトウィザードですぐに開始

テンプレート（論文、学位論文、プレゼンテーション、ポスター、レターなど）を選び、名前を付け、必要に応じて内容を説明すると、ClaudePrism がプロジェクトをセットアップし、AI が初期コンテンツを生成します。参考ファイル（PDF、BIB、画像）をドラッグ & ドロップすれば、そのまま執筆を始められます。

<p align="center">
  <img src="./assets/demo/starter.webp" alt="テンプレートギャラリー & プロジェクトウィザード" width="700" />
</p>

### Claude AI アシスタント

エディタ上で Claude と直接チャットできます。Sonnet・Opus・Haiku のモデルを切り替えられ、推論レベルも調整できます。セッションは保持され、ツール呼び出し（ファイル編集、bash、検索）や、拡張可能なスラッシュコマンドにも対応しています。

<p align="center">
  <img src="./assets/demo/claudecommand.webp" alt="Claude AI アシスタント & スラッシュコマンド" width="600" />
</p>

### 履歴 & 変更提案のレビュー

保存するたびに、ローカル Git リポジトリ（`.claudeprism/history.git/`）にスナップショットが作成されます。重要なチェックポイントにラベルを付けたり、任意の 2 つのスナップショット間の diff を確認したり、以前のバージョンに復元したりできます。Claude が編集を提案すると、専用パネルに視覚的な差分とともに表示され、チャンクごとに承認・却下、または一括で適用・取り消し（`⌘Y` / `⌘N`）できます。

<p align="center">
  <img src="./assets/demo/history.webp" alt="履歴 & 変更提案" width="700" />
</p>

### オフライン LaTeX コンパイル

Tectonic がアプリに直接組み込まれています。パッケージは初回使用時に一度だけダウンロードされ、ローカルにキャッシュされます。それ以降は TeX Live をインストールしなくても、完全にオフラインでコンパイルできます。

### キャプチャしてそのまま質問

`⌘X` でキャプチャモードに入り、PDF 上の任意の領域をドラッグして選択すると、キャプチャした画像がチャット入力欄に固定され、そのまま Claude に質問できます。数式、図表、査読コメントについて質問するのに便利です。

<p align="center">
  <img src="./assets/demo/capture_ask.webp" alt="キャプチャ & 質問" width="700" />
</p>

### リアルタイム PDF プレビュー

SyncTeX 対応のネイティブ MuPDF レンダリングを採用しています。PDF 上の位置をクリックすると、対応するソース行へジャンプできます。ズーム、テキスト選択、キャプチャにも対応しています。

### エディタ

CodeMirror 6 ベースのエディタで、LaTeX / BibTeX のシンタックスハイライト、リアルタイムのエラー検出、検索 & 置換（正規表現対応）、自動保存付きのマルチファイルプロジェクトをサポートしています。

### その他

- **Zotero 連携** ── OAuth ベースの文献管理と引用挿入

<p align="center">
  <img src="./assets/demo/zotero.webp" alt="Zotero 連携" width="300" />
</p>

- **スラッシュコマンド** ── 組み込み（`/review`, `/init`）+ `.claude/commands/` のカスタムコマンド
- **外部エディタ** ── Cursor、VS Code、Zed、Sublime Text でプロジェクトを開けます
- **ダーク / ライトテーマ** ── 自動切り替え

---

## インストール

[GitHub Releases](https://github.com/delibae/claude-prism/releases) から最新ビルドをダウンロードしてください。

## コントリビュート

コントリビュートを歓迎します。開発環境のセットアップ、テスト、ガイドラインについては [CONTRIBUTING.md](./CONTRIBUTING.md) を参照してください。

## 謝辞

本プロジェクトは、[assistant-ui](https://github.com/assistant-ui) による [Open Prism](https://github.com/assistant-ui/open-prism) をもとに開発されました。

## ライセンス

[MIT](./LICENSE)
