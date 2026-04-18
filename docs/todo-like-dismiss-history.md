# TODO: like / dismiss 履歴の閲覧機能

## 概要

設定画面から like・dismiss 履歴を見返せるようにする。
ブックマーク（`bookmarks` ストア）と同様のUI。

## 仕様メモ

- **like 履歴**: 全件保持。設定画面の新タブ「いいね」から一覧表示
- **dismiss 履歴**: 最新 15 件のみ保持（古いものを自動削除）。「スキップ済み」タブ

## 必要な実装

### 1. DB スキーマ変更（`js/db.js`）

現在の `swipes` ストアは `{ tweetId, action, swipedAt }` のみでツイート本文がない。
ブックマーク同様に本文・著者・メディアを保存するストアを追加する。

**案A**: `swipes` ストアを拡張して本文も保存する
**案B**: `likes` / `dismisses` を別ストアとして追加する（bookmarks と同構造）

推奨は **案B**（既存の `swipes`（既読管理用）と履歴表示用を分離）。

```
likes     — { tweetId, feedId, author, text, media, link, createdAt, likedAt }
dismisses — { tweetId, feedId, author, text, media, link, createdAt, dismissedAt }
            ※ dismisses は最新 15 件のみ保持
```

`DB_VERSION` を 3 にインクリメントし、マイグレーションで両ストアを追加。

### 2. スワイプ時の保存（`js/app.js`）

```js
// handleLike
await saveLike(tweet, currentFeedId);   // likes ストアに保存

// handleDismiss
await saveDismiss(tweet, currentFeedId); // dismisses ストアに保存（15件超えたら古い順に削除）
```

### 3. UI（`index.html` / `css/style.css`）

- 設定画面またはボトムナビに「いいね」タブを追加
- ブックマーク画面と同じカードリスト形式で表示
- dismiss は「最新 15 件」であることを明示

### 4. 削除ロジック（dismiss の件数上限）

```js
export async function saveDismiss(tweet, feedId) {
  const store = await tx('dismisses', 'readwrite');
  await wrap(store.put({ tweetId: tweet.id, feedId, ...tweet, dismissedAt: Date.now() }));

  // 15件超えたら古いものを削除
  const all = await wrap(store.index('dismissedAt').getAll());
  all.sort((a, b) => a.dismissedAt - b.dismissedAt); // 古い順
  for (const item of all.slice(0, Math.max(0, all.length - 15))) {
    await wrap(store.delete(item.tweetId));
  }
}
```

## 注意点

- `swipes` ストア（既読管理）はそのまま残す。履歴ストアとは別物
- dismiss した投稿が 15 件を超えて削除されても `swipes` には残るので再表示はされない
- `rewriteVideoUrls()` は表示直前に行うため、保存時は元の `video.twimg.com` URL のまま保存する
