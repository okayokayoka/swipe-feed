/**
 * db.js — IndexedDB ラッパー
 *
 * ストア一覧:
 *   posts    — 取得したツイートのキャッシュ
 *   swipes   — スワイプ記録（like / dismiss / bookmark）
 *   bookmarks — ブックマークライブラリ
 *   authors  — 著者アフィニティ（likeカウント）
 *   settings — アプリ設定（auth_token, workerUrl など）
 */

const DB_NAME = 'swipe-app';
const DB_VERSION = 1;

let _db = null;

/** IndexedDB を開く（初回は自動マイグレーション） */
export function openDB() {
  if (_db) return Promise.resolve(_db);

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (event) => {
      const db = event.target.result;

      // posts ストア（ツイートキャッシュ）
      if (!db.objectStoreNames.contains('posts')) {
        const store = db.createObjectStore('posts', { keyPath: 'id' });
        store.createIndex('feedId', 'feedId');
        store.createIndex('createdAtMs', 'createdAtMs');
      }

      // swipes ストア（スワイプ履歴）
      if (!db.objectStoreNames.contains('swipes')) {
        const store = db.createObjectStore('swipes', { keyPath: 'tweetId' });
        store.createIndex('action', 'action');
        store.createIndex('swipedAt', 'swipedAt');
      }

      // bookmarks ストア（ブックマーク）
      if (!db.objectStoreNames.contains('bookmarks')) {
        const store = db.createObjectStore('bookmarks', { keyPath: 'tweetId' });
        store.createIndex('bookmarkedAt', 'bookmarkedAt');
        store.createIndex('feedId', 'feedId');
      }

      // authors ストア（著者アフィニティ）
      if (!db.objectStoreNames.contains('authors')) {
        db.createObjectStore('authors', { keyPath: 'handle' });
      }

      // settings ストア（設定）
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'key' });
      }
    };

    req.onsuccess = (e) => {
      _db = e.target.result;
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}

/** 汎用: トランザクションを開く */
async function tx(storeName, mode = 'readonly') {
  const db = await openDB();
  return db.transaction(storeName, mode).objectStore(storeName);
}

/** 汎用: IDBRequest を Promise でラップ */
function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ────────────────────────────────────────
// Settings
// ────────────────────────────────────────

export async function getSetting(key) {
  const store = await tx('settings');
  const record = await wrap(store.get(key));
  return record?.value ?? null;
}

export async function setSetting(key, value) {
  const store = await tx('settings', 'readwrite');
  return wrap(store.put({ key, value }));
}

/** アプリ設定を一括取得 */
export async function loadSettings() {
  const [authToken, ct0, workerUrl, proxySecret, feeds] = await Promise.all([
    getSetting('authToken'),
    getSetting('ct0'),
    getSetting('workerUrl'),
    getSetting('proxySecret'),
    getSetting('feeds'),
  ]);
  return { authToken, ct0, workerUrl, proxySecret, feeds };
}

// ────────────────────────────────────────
// Posts（ツイートキャッシュ）
// ────────────────────────────────────────

/** ツイートを一括保存（既存は上書き） */
export async function savePosts(tweets, feedId) {
  const store = await tx('posts', 'readwrite');
  const saves = tweets.map(tweet =>
    wrap(store.put({ ...tweet, feedId }))
  );
  return Promise.all(saves);
}

/**
 * スワイプ済みを除いた未読ポストを取得
 * @param {string|null} feedId - null の場合は全フィード
 * @param {number} limit
 */
export async function getUnreadPosts(feedId = null, limit = 30) {
  const db = await openDB();

  // 全ポストを取得
  const postsTx = db.transaction('posts', 'readonly').objectStore('posts');
  const allPosts = await wrap(postsTx.getAll());

  // スワイプ済み ID セット
  const swipesTx = db.transaction('swipes', 'readonly').objectStore('swipes');
  const allSwipes = await wrap(swipesTx.getAll());
  const swipedIds = new Set(allSwipes.map(s => s.tweetId));

  // フィルタリング
  let posts = allPosts.filter(p => !swipedIds.has(p.id));
  if (feedId) posts = posts.filter(p => p.feedId === feedId);

  // アルゴリズムでソート
  const authorsMap = await getAuthorsMap();
  posts = sortByAlgorithm(posts, authorsMap);

  return posts.slice(0, limit);
}

// ────────────────────────────────────────
// Swipes（スワイプ記録）
// ────────────────────────────────────────

export async function recordSwipe(tweetId, action) {
  const store = await tx('swipes', 'readwrite');
  return wrap(store.put({ tweetId, action, swipedAt: Date.now() }));
}

export async function hasSwipped(tweetId) {
  const store = await tx('swipes');
  const record = await wrap(store.get(tweetId));
  return !!record;
}

// ────────────────────────────────────────
// Bookmarks（ブックマーク）
// ────────────────────────────────────────

export async function addBookmark(tweet, feedId) {
  const store = await tx('bookmarks', 'readwrite');
  return wrap(store.put({
    tweetId: tweet.id,
    feedId,
    author: tweet.author,
    text: tweet.text,
    media: tweet.media,
    quotedTweet: tweet.quotedTweet,
    link: tweet.link,
    createdAt: tweet.createdAt,
    bookmarkedAt: Date.now(),
  }));
}

export async function removeBookmark(tweetId) {
  const store = await tx('bookmarks', 'readwrite');
  return wrap(store.delete(tweetId));
}

/**
 * ブックマーク一覧を取得
 * @param {{ feedId?: string, query?: string, limit?: number, offset?: number }}
 */
export async function getBookmarks({ feedId, query, limit = 30, offset = 0 } = {}) {
  const store = await tx('bookmarks');
  let all = await wrap(store.getAll());

  if (feedId) all = all.filter(b => b.feedId === feedId);
  if (query) {
    const q = query.toLowerCase();
    all = all.filter(b =>
      b.text?.toLowerCase().includes(q) ||
      b.author?.handle?.toLowerCase().includes(q) ||
      b.author?.name?.toLowerCase().includes(q)
    );
  }

  // 新しい順
  all.sort((a, b) => b.bookmarkedAt - a.bookmarkedAt);
  return all.slice(offset, offset + limit);
}

export async function getBookmarkCount() {
  const store = await tx('bookmarks');
  return wrap(store.count());
}

// ────────────────────────────────────────
// Authors（著者アフィニティ）
// ────────────────────────────────────────

export async function incrementAuthorLike(handle) {
  const store = await tx('authors', 'readwrite');
  const existing = await wrap(store.get(handle));
  const likeCount = (existing?.likeCount ?? 0) + 1;
  return wrap(store.put({ handle, likeCount, lastLikedAt: Date.now() }));
}

export async function getAuthorsMap() {
  const store = await tx('authors');
  const all = await wrap(store.getAll());
  const map = {};
  for (const a of all) map[a.handle] = a.likeCount;
  return map;
}

// ────────────────────────────────────────
// アルゴリズム（表示順ソート）
// ────────────────────────────────────────

/**
 * 著者アフィニティ + 鮮度 + 多様性ペナルティでソート。
 * @param {object[]} posts
 * @param {Record<string, number>} authorsMap - { handle: likeCount }
 */
function sortByAlgorithm(posts, authorsMap) {
  const now = Date.now();

  // スコアを計算
  const scored = posts.map(p => {
    const ageMs = now - (p.createdAtMs || 0);
    const ageH = ageMs / 3_600_000;

    // 著者アフィニティ
    const likeCount = authorsMap[p.author?.handle] ?? 0;
    const affinity = likeCount >= 3 ? 30 : likeCount === 2 ? 20 : likeCount === 1 ? 10 : 0;

    // 鮮度
    const freshness = ageH <= 1 ? 20 : ageH <= 6 ? 15 : ageH <= 24 ? 10 : ageH <= 48 ? 5 : 0;

    return { ...p, _score: affinity + freshness };
  });

  // スコア降順でソート（同スコアは新しい順）
  scored.sort((a, b) => {
    if (b._score !== a._score) return b._score - a._score;
    return (b.createdAtMs || 0) - (a.createdAtMs || 0);
  });

  // 多様性ペナルティ: 直前3枚に同じ著者がいれば後ろに移動
  const result = [];
  const recentHandles = [];
  const remaining = [...scored];

  while (remaining.length > 0) {
    // 直前3枚に著者が被っていない最初の候補を選ぶ
    const idx = remaining.findIndex(p => !recentHandles.includes(p.author?.handle));
    const pick = idx === -1 ? remaining.shift() : remaining.splice(idx, 1)[0];

    result.push(pick);
    recentHandles.push(pick.author?.handle);
    if (recentHandles.length > 3) recentHandles.shift();
  }

  return result;
}

// ────────────────────────────────────────
// バックアップ / リストア
// ────────────────────────────────────────

/** デバッグ用: posts キャッシュを削除してカードをリセット（スワイプ履歴は保持） */
export async function clearPostsAndSwipes() {
  const db = await openDB();
  await wrap(db.transaction('posts', 'readwrite').objectStore('posts').clear());
}

/** ブックマークをJSONとしてエクスポート */
export async function exportBookmarks() {
  const store = await tx('bookmarks');
  const all = await wrap(store.getAll());
  const json = JSON.stringify(all, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `swipe-bookmarks-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
