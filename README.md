# Paper Catcher

Paper Catcherは、経済学の論文を自動的に収集し、日本語で要約・翻訳して提供するウェブアプリケーションです。ユーザーが設定したキーワードに関連する論文を各種APIで取得し、Gemini APIを使用して日本語訳を作成し、GitHubページに自動的に更新します。

## 機能

- **自動論文収集**: 設定したキーワードに基づいて論文を自動的に収集
- **日本語翻訳**: 論文のタイトルと要約を日本語に翻訳
- **カテゴリ分類**: （例）「教育・労働経済学」と「経済学一般」のカテゴリに分類
- **多様なソート機能**: 登録日付順、取得順、ジャーナル別、出版日別でソート可能
- **アーカイブ機能**: 過去の論文をアーカイブとして閲覧可能
- **モバイル対応**: レスポンシブデザインによりスマートフォンやタブレットでも快適に閲覧可能

## セットアップ方法

### 前提条件

- Node.js (v14以上)
- npm または yarn
- GitHub アカウント
- Google Cloud Platform アカウント (Gemini APIのため)

### インストール手順

1. リポジトリをクローンします

```bash
git clone https://github.com/yourusername/econ-paper-catcher.git
cd econ-paper-catcher
```

2. 依存パッケージをインストールします

```bash
npm install
```

3. 環境変数を設定します

`.env`ファイルをプロジェクトのルートディレクトリに作成し、以下の内容を追加します：

```
GEMINI_API_KEY=your_gemini_api_key
AWS_ACCESS_KEY_ID=your_aws_access_key_id
AWS_SECRET_ACCESS_KEY=your_aws_secret_access_key
AWS_REGION=your_aws_region
```

4. アプリケーションを起動します

```bash
npm start
```

### GitHub Pagesへのデプロイ

1. `package.json`の`homepage`フィールドを自分のGitHubユーザー名とリポジトリ名に更新します

```json
"homepage": "https://yourusername.github.io/econ-paper-catcher/"
```

2. GitHub Pagesにデプロイします

```bash
npm run deploy
```

### GitHub Pagesへのデプロイについて

GitHub Pagesへのデプロイは、セキュリティ上の問題により自動的に完了できませんでした。リポジトリのオーナーとして、以下の方法でデプロイを完了できます：

1. GitHubのリポジトリページにアクセス
2. 「Settings」→「Pages」を選択
3. ソースとして「GitHub Actions」を選択
4. 提供されているワークフローテンプレートから「Static HTML」を選択してデプロイ

Tabibito-AI's personal token 👇[TOKEN_REMOVED_FOR_SECURITY]

## 自動更新の設定

このアプリケーションは、GitHub Actionsを使用して毎日自動的に論文を収集し、ウェブページを更新します。

### GitHub Actionsの設定

1. リポジトリの「Settings」タブから「Secrets and variables」→「Actions」を選択します
2. 以下のシークレットを追加します：
   - `GEMINI_API_KEY`: Gemini APIのキー
   - `AWS_ACCESS_KEY_ID`: AWS Access Key ID
   - `AWS_SECRET_ACCESS_KEY`: AWS Secret Access Key
   - `AWS_REGION`: AWSリージョン

## カスタマイズ方法

### 収集するキーワードの変更

`app.mjs`ファイル内の`keywords`配列を編集して、収集したいキーワードを設定します：

```javascript
const keywords = [
  { term: "education economics", category: "教育・労働経済学" },
  { term: "labor economics", category: "教育・労働経済学" },
  { term: "economic growth", category: "経済学一般" },
  // 他のキーワードを追加
];
```

### カテゴリの追加・変更

1. `app.mjs`ファイル内の`keywords`配列でカテゴリを定義します
2. `index.html`ファイル内の`.filter-buttons`セクションにカテゴリボタンを追加します：

```html
<div class="filter-buttons">
  <button class="filter-btn active">教育・労働経済学</button>
  <button class="filter-btn">経済学一般</button>
  <button class="filter-btn">新しいカテゴリ</button>
</div>
```

## 使用方法

### 論文の閲覧

1. ウェブページにアクセスすると、最新の論文が表示されます
2. 上部のフィルターボタンでカテゴリを選択できます
3. ソートボタンで表示順を変更できます：
   - 📅 登録日付順: 論文がシステムに登録された日付順
   - ≡ 取得順: 論文が取得された順番
   - 📚 ジャーナル別: ジャーナル名のアルファベット順
   - ⏱ 出版日別: 論文の出版日順
   - 📚 アーカイブ: すべての論文を表示

### 論文の詳細表示

論文カードの「詳細」ボタンをクリックすると、モーダルウィンドウで論文の詳細情報が表示されます：
- 論文タイトル（英語と日本語）
- 著者情報
- ジャーナル名
- 論文へのリンク（利用可能な場合）
- 要約（英語と日本語）

## アーキテクチャ

Econ Paper Catcherは以下のコンポーネントで構成されています：

1. **バックエンド（Node.js）**:
   - `app.mjs`: メインのアプリケーションロジック
   - `webScraper.js`: 論文情報のスクレイピング

2. **フロントエンド（HTML/CSS/JavaScript）**:
   - `index.html`: メインのHTMLファイル
   - `styles.css`: スタイルシート
   - `src/index.js`: フロントエンドのJavaScriptロジック

3. **ビルドツール**:
   - Webpack: JavaScriptのバンドル

4. **デプロイ**:
   - GitHub Pages: 静的ウェブサイトのホスティング
   - GitHub Actions: 自動更新ワークフロー

## API統合

このアプリケーションは以下のAPIを使用しています：

1. **学術論文API**:
   - arXiv API
   - Semantic Scholar API
   - CrossRef API

2. **翻訳API**:
   - Google Gemini API: 論文タイトルと要約の翻訳

## トラブルシューティング

### 論文が更新されない場合

1. GitHub Actionsのログを確認して、エラーがないか確認します
2. `.env`ファイルのAPI鍵が正しく設定されているか確認します
3. インターネット接続を確認します

### デプロイに失敗する場合

1. `package.json`の`homepage`フィールドが正しく設定されているか確認します
2. GitHub Pagesが有効になっているか確認します（リポジトリの「Settings」→「Pages」）
3. GitHub Actionsの権限が正しく設定されているか確認します

## ライセンス

このプロジェクトはMITライセンスの下で公開されています。詳細は[LICENSE](LICENSE)ファイルを参照してください。

## 貢献

バグ報告や機能リクエストは、GitHubのIssueで受け付けています。プルリクエストも歓迎します。

## 謝辞

このプロジェクトは、以下のオープンソースライブラリとAPIに依存しています：

- Node.js
- Webpack
- arXiv API
- Semantic Scholar API
- CrossRef API
- Google Gemini API

## 連絡先

質問や提案がある場合は、GitHubのIssueを作成してください。
