/**
 * app.js — メインエントリポイント
 *
 * 担当:
 *   - 画面切替ナビゲーション
 *   - フィードタブ管理
 *   - CardStack の初期化・フィード取得
 *   - ブックマーク画面
 *   - 設定画面
 *   - トースト通知
 */

import { fetchListTimeline } from './api.js';
import {
  openDB, loadSettings, setSetting,
  savePosts, getUnreadPosts,
  recordSwipe, incrementAuthorLike,
  addBookmark, removeBookmark, getBookmarks, getBookmarkCount,
  getAuthorsMap, exportBookmarks,
} from './db.js';
import { CardStack, triggerSwipeAction } from './swipe.js';

// ────────────────────────────────────────────────────────────────
// デフォルトフィード設定
// ────────────────────────────────────────────────────────────────
const DEFAULT_FEEDS = [
  { id: 'tech',    name: 'Tech',    listId: '2039195389270913259' },
  { id: 'games',   name: 'Games',   listId: '2039204263470285206' },
  { id: 'toys',    name: 'Toys',    listId: '2039202935536832833' },
  { id: 'gadgets', name: 'Gadgets', listId: '2039204038647103800' },
  { id: 'books',   name: 'Books',   listId: '2039206851309609264' },
  { id: 'foods',   name: 'Foods',   listId: '2039221154691653645' },
  { id: 'friends', name: 'Friends', listId: '2039207895963992261' },
  { id: 'etc',     name: 'Etc',     listId: '1783369589369499680' },
];

// ────────────────────────────────────────────────────────────────
// 状態
// ────────────────────────────────────────────────────────────────
let settings = {};
let feeds = DEFAULT_FEEDS;
let currentFeedId = feeds[0].id;
let stack = null;
let authorsMap = {};

// ────────────────────────────────────────────────────────────────
// 初期化
// ────────────────────────────────────────────────────────────────
async function init() {
  await openDB();
  settings = await loadSettings();

  // 設定からフィード一覧を復元
  if (settings.feeds) {
    try { feeds = JSON.parse(settings.feeds); } catch { /* デフォルト使用 */ }
  }

  // auth_token 未設定ならセットアップ画面を表示
  if (!settings.authToken || !settings.workerUrl) {
    showScreen('setup');
    return;
  }

  // メイン画面を初期化
  await setupMainScreen();
  showScreen('swipe');
}

// ────────────────────────────────────────────────────────────────
// メイン画面のセットアップ
// ────────────────────────────────────────────────────────────────
async function setupMainScreen() {
  authorsMap = await getAuthorsMap();
  buildFeedTabs();
  buildStack();
  await loadFeed(currentFeedId);
}

function buildFeedTabs() {
  const tabsEl = document.getElementById('feed-tabs');
  tabsEl.innerHTML = '';
  feeds.forEach(feed => {
    const btn = document.createElement('button');
    btn.className = 'feed-tab' + (feed.id === currentFeedId ? ' active' : '');
    btn.textContent = feed.name;
    btn.dataset.feedId = feed.id;
    btn.addEventListener('click', () => switchFeed(feed.id));
    tabsEl.appendChild(btn);
  });
}

function buildStack() {
  stack = new CardStack('#card-stack', {
    onLike: handleLike,
    onDismiss: handleDismiss,
    onBookmark: handleBookmark,
    onEmpty: handleEmpty,
    getAffinity: (handle) => authorsMap[handle] ?? 0,
  });
}

// ────────────────────────────────────────────────────────────────
// フィード読み込み
// ────────────────────────────────────────────────────────────────
async function loadFeed(feedId) {
  showLoading(true);

  try {
    // まずDBのキャッシュを表示（オフライン対応）
    let posts = await getUnreadPosts(feedId, 30);

    if (posts.length < 5) {
      // キャッシュが少なければAPIから取得
      posts = await fetchAndCache(feedId) ?? posts;
    }

    authorsMap = await getAuthorsMap();
    stack.load(posts, feedId);
    updateRemainingBadge();
  } catch (err) {
    console.error('フィード読み込みエラー:', err);
    showToast('読み込みに失敗しました');
    // キャッシュだけで続行
    const posts = await getUnreadPosts(feedId, 30);
    stack.load(posts, feedId);
  } finally {
    showLoading(false);
  }
}

async function fetchAndCache(feedId) {
  const feed = feeds.find(f => f.id === feedId);
  if (!feed) return null;

  const { tweets } = await fetchListTimeline({
    listId: feed.listId,
    authToken: settings.authToken,
    workerUrl: settings.workerUrl,
    proxySecret: settings.proxySecret,
    count: 40,
  });

  if (tweets.length > 0) {
    await savePosts(tweets, feedId);
  }

  return getUnreadPosts(feedId, 30);
}

// ────────────────────────────────────────────────────────────────
// フィード切替
// ────────────────────────────────────────────────────────────────
async function switchFeed(feedId) {
  if (feedId === currentFeedId) return;
  currentFeedId = feedId;

  // タブのactive切替
  document.querySelectorAll('.feed-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.feedId === feedId);
  });

  await loadFeed(feedId);
}

// ────────────────────────────────────────────────────────────────
// スワイプアクション
// ────────────────────────────────────────────────────────────────
async function handleLike(tweet) {
  await Promise.all([
    recordSwipe(tweet.id, 'like'),
    incrementAuthorLike(tweet.author?.handle),
  ]);
  authorsMap = await getAuthorsMap();
  updateRemainingBadge();
}

async function handleDismiss(tweet) {
  await recordSwipe(tweet.id, 'dismiss');
  updateRemainingBadge();
}

async function handleBookmark(tweet) {
  await Promise.all([
    recordSwipe(tweet.id, 'bookmark'),
    addBookmark(tweet, currentFeedId),
  ]);
  showToast('★ ブックマークに保存しました');
  updateRemainingBadge();
}

async function handleEmpty() {
  // カードが無くなった → APIから追加取得を試みる
  const feed = feeds.find(f => f.id === currentFeedId);
  if (!feed) return;

  try {
    showLoading(true);
    const posts = await fetchAndCache(currentFeedId);
    if (posts && posts.length > 0) {
      authorsMap = await getAuthorsMap();
      stack.load(posts, currentFeedId);
    }
  } catch (err) {
    console.error('追加読み込みエラー:', err);
  } finally {
    showLoading(false);
    updateRemainingBadge();
  }
}

function updateRemainingBadge() {
  const el = document.getElementById('remaining-badge');
  if (!el || !stack) return;
  const n = stack.remaining;
  el.textContent = n > 0 ? `残り ${n} 件` : '';
}

// ────────────────────────────────────────────────────────────────
// ブックマーク画面
// ────────────────────────────────────────────────────────────────
async function renderBookmarks(query = '') {
  const list = document.getElementById('bookmark-list');
  list.innerHTML = '';

  const items = await getBookmarks({ query, limit: 50 });

  if (items.length === 0) {
    list.innerHTML = `<div class="bookmarks-empty">ブックマークはまだありません</div>`;
    return;
  }

  items.forEach(item => {
    const el = document.createElement('div');
    el.className = 'bookmark-item';
    el.dataset.tweetId = item.tweetId;

    const thumbHTML = item.images?.[0]
      ? `<img class="bookmark-thumb" src="${escHtml(item.images[0])}" loading="lazy" alt="" onerror="this.outerHTML='<div class=\\'bookmark-thumb-placeholder\\'>📌</div>'">`
      : `<div class="bookmark-thumb-placeholder">📌</div>`;

    const relTime = relativeTime(item.bookmarkedAt);

    el.innerHTML = `
      ${thumbHTML}
      <div class="bookmark-info">
        <span class="bookmark-author">@${escHtml(item.author?.handle ?? '')}</span>
        <p class="bookmark-text">${escHtml(item.text ?? '')}</p>
        <span class="bookmark-meta">${escHtml(item.feedId)} · ${relTime}</span>
      </div>
      <button class="bookmark-delete-btn" aria-label="削除" data-id="${item.tweetId}">×</button>`;

    // タップでツイートを開く
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('bookmark-delete-btn')) return;
      window.open(item.link, '_blank', 'noopener');
    });

    // 削除ボタン
    el.querySelector('.bookmark-delete-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      await removeBookmark(item.tweetId);
      el.remove();
      if (!list.querySelector('.bookmark-item')) {
        list.innerHTML = `<div class="bookmarks-empty">ブックマークはまだありません</div>`;
      }
    });

    list.appendChild(el);
  });
}

function relativeTime(ts) {
  const ms = Date.now() - ts;
  const s = ms / 1000;
  if (s < 60)    return 'たった今';
  const m = s / 60;
  if (m < 60)    return `${Math.floor(m)}分前`;
  const h = m / 60;
  if (h < 24)    return `${Math.floor(h)}時間前`;
  const d = h / 24;
  return `${Math.floor(d)}日前`;
}

function escHtml(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ────────────────────────────────────────────────────────────────
// 設定画面
// ────────────────────────────────────────────────────────────────
function renderSettings() {
  document.getElementById('setting-auth-token').value = settings.authToken ?? '';
  document.getElementById('setting-worker-url').value = settings.workerUrl ?? '';
  document.getElementById('setting-proxy-secret').value = settings.proxySecret ?? '';

  renderFeedList();
}

function renderFeedList() {
  const list = document.getElementById('feed-list');
  list.innerHTML = '';
  feeds.forEach((feed, i) => {
    const item = document.createElement('div');
    item.className = 'feed-list-item';
    item.innerHTML = `
      <span class="feed-list-item-name">${escHtml(feed.name)}</span>
      <span class="feed-list-item-id">${escHtml(feed.listId)}</span>
      <span class="feed-list-item-remove" data-index="${i}" aria-label="削除">×</span>`;
    item.querySelector('.feed-list-item-remove').addEventListener('click', () => {
      feeds.splice(i, 1);
      renderFeedList();
    });
    list.appendChild(item);
  });
}

async function saveSettings() {
  const authToken   = document.getElementById('setting-auth-token').value.trim();
  const workerUrl   = document.getElementById('setting-worker-url').value.trim();
  const proxySecret = document.getElementById('setting-proxy-secret').value.trim();

  if (!authToken || !workerUrl) {
    showToast('auth_token と Worker URL は必須です');
    return;
  }

  await Promise.all([
    setSetting('authToken',   authToken),
    setSetting('workerUrl',   workerUrl),
    setSetting('proxySecret', proxySecret),
    setSetting('feeds',       JSON.stringify(feeds)),
  ]);

  settings = { authToken, workerUrl, proxySecret, feeds: JSON.stringify(feeds) };
  showToast('保存しました');

  // 再初期化
  await setupMainScreen();
  showScreen('swipe');
}

// ────────────────────────────────────────────────────────────────
// 画面切替
// ────────────────────────────────────────────────────────────────
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(`screen-${name}`)?.classList.add('active');

  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`[data-screen="${name}"]`)?.classList.add('active');

  if (name === 'bookmarks') {
    const query = document.getElementById('bookmark-search')?.value ?? '';
    renderBookmarks(query);
  }
  if (name === 'settings') {
    renderSettings();
  }
}

// ────────────────────────────────────────────────────────────────
// ローディング
// ────────────────────────────────────────────────────────────────
function showLoading(show) {
  const el = document.getElementById('loading-overlay');
  if (!el) return;
  el.classList.toggle('hidden', !show);
}

// ────────────────────────────────────────────────────────────────
// トースト
// ────────────────────────────────────────────────────────────────
function showToast(msg, duration = 2200) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  container.appendChild(el);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => el.classList.add('show'));
  });

  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, duration);
}

// ────────────────────────────────────────────────────────────────
// イベントバインド（DOMContentLoaded後）
// ────────────────────────────────────────────────────────────────
// Service Worker 登録（PWAインストールプロンプトに必要）
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(err => {
    console.warn('SW登録失敗:', err);
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  // ナビゲーションボタン
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => showScreen(btn.dataset.screen));
  });

  // アクションボタン
  document.getElementById('btn-dismiss')?.addEventListener('click',  () => triggerSwipeAction('dismiss'));
  document.getElementById('btn-like')?.addEventListener('click',     () => triggerSwipeAction('like'));
  document.getElementById('btn-bookmark')?.addEventListener('click', () => triggerSwipeAction('bookmark'));

  // ブックマーク検索
  document.getElementById('bookmark-search')?.addEventListener('input', (e) => {
    renderBookmarks(e.target.value);
  });

  // 設定の保存
  document.getElementById('btn-save-settings')?.addEventListener('click', saveSettings);

  // エクスポート
  document.getElementById('btn-export')?.addEventListener('click', async () => {
    await exportBookmarks();
    showToast('JSONをダウンロードしました');
  });

  // フィード追加
  document.getElementById('btn-add-feed')?.addEventListener('click', () => {
    const name   = prompt('フィード名 (例: tech)');
    if (!name) return;
    const listId = prompt('X リスト ID (数字)');
    if (!listId) return;
    const id = name.toLowerCase().replace(/\s+/g, '-');
    feeds.push({ id, name, listId });
    renderFeedList();
  });

  // セットアップ画面の保存
  document.getElementById('btn-setup-save')?.addEventListener('click', async () => {
    const authToken = document.getElementById('setup-auth-token').value.trim();
    const workerUrl = document.getElementById('setup-worker-url').value.trim();
    if (!authToken || !workerUrl) {
      showToast('両方入力してください');
      return;
    }
    await Promise.all([
      setSetting('authToken', authToken),
      setSetting('workerUrl', workerUrl),
    ]);
    settings.authToken = authToken;
    settings.workerUrl = workerUrl;
    await setupMainScreen();
    showScreen('swipe');
  });

  // 起動
  await init();
});
