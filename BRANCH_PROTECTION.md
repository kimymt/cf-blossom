# Main Branch Protection Settings

このドキュメントでは、cf-blossomリポジトリのmainブランチ保護設定について説明します。

## 保護ルール概要

mainブランチには以下の保護ルールが適用されています：

- ✅ **プルリクエストレビュー必須**: mainブランチへの直接プッシュを禁止し、すべての変更をプルリクエスト経由で行う
- ✅ **強制プッシュ禁止**: `git push --force` によるブランチの上書きを防止

## GitHub UIでの設定手順

### 1. Settings タブに移動
- リポジトリの「Settings」タブをクリック

### 2. Branches セクションを開く
- 左側メニューの「Branches」をクリック

### 3. Branch protection rule を追加
- 「Add rule」をクリック

### 4. 以下の設定を行う

#### Pattern name
```
main
```

#### ✅ Require pull request reviews before merging
- チェック: **ON**
- Required number of reviews before merge: `1`
- Require approvals from code owners: **OFF**（オプション）
- Dismiss stale pull request approvals when new commits are pushed: **OFF**
- Allow specified actors to bypass required pull requests: **OFF**

#### ✅ Require status checks to pass before merging
- チェック: **OFF**（オプション - CI/CDを後で追加可能）

#### ✅ Require branches to be up to date before merging
- チェック: **OFF**（オプション）

#### ✅ Restrict who can push to matching branches
- チェック: **OFF**（すべてのユーザーがPRを作成可能）

#### ✅ Allow force pushes
- **Allow force pushes**: 「Deny」を選択
- または「Nobody」を選択

#### ✅ Allow deletions
- チェック: **OFF**

#### ✅ Require signed commits
- チェック: **OFF**（オプション）

### 5. 「Create」をクリックして保存

## 検証方法

保護ルールが有効になったことを確認するには：

1. `main`ブランチへの直接プッシュを試みる：
   ```bash
   git push origin main
   ```
   → エラーが出て拒否されることを確認

2. `git push --force` を試みる：
   ```bash
   git push origin --force
   ```
   → エラーが出て拒否されることを確認

3. プルリクエスト経由での変更は以下の手順で行う：
   ```bash
   git checkout -b feature/your-feature
   # 変更を加える
   git push origin feature/your-feature
   # GitHub UIでプルリクエストを作成
   ```

## 今後の拡張

必要に応じて以下の保護ルールを追加できます：

- **ステータスチェック必須**: CIが成功していることを確認
- **確定レビュー数の増加**: より多くのレビュー承認を必須にする
- **署名済みコミット必須**: セキュリティ強化
- **期限付きレビュー**: 古いレビューを自動で無効化
