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
  getAuthorsMap, exportBookmarks, clearPostsCache,
} from './db.js';
import { CardStack, triggerSwipeAction, buildCardHTML } from './swipe.js';

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
let _loadGeneration = 0;
let _navSyncScheduled = false;

function syncBottomNavOffset() {
  const nav = document.querySelector('.bottom-nav');
  if (!nav) return;

  const height = Math.ceil(nav.getBoundingClientRect().height);
  if (height > 0) {
    document.documentElement.style.setProperty('--bottom-nav-offset', `${height}px`);
  } else {
    document.documentElement.style.removeProperty('--bottom-nav-offset');
  }
}

function scheduleBottomNavOffsetSync() {
  if (_navSyncScheduled) return;
  _navSyncScheduled = true;

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      _navSyncScheduled = false;
      syncBottomNavOffset();
    });
  });
}

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
  if (!settings.authToken || !settings.ct0 || !settings.workerUrl) {
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
  if (!stack) buildStack();  // 初回のみ作成（重複リスナー防止）
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
// 動画URLをWorkerプロキシ経由に書き換える（キャッシュ済み直接URLの救済含む）
// ────────────────────────────────────────────────────────────────
function rewriteVideoUrls(posts) {
  const { workerUrl, proxySecret } = settings;
  if (!workerUrl) return posts;
  return posts.map(post => {
    if (!post.media?.length) return post;
    const newMedia = post.media.map(m => {
      if ((m.type === 'video' || m.type === 'animated_gif') &&
          m.url && !m.url.startsWith(workerUrl)) {
        const params = new URLSearchParams({ url: m.url });
        if (proxySecret) params.set('secret', proxySecret);
        return { ...m, url: `${workerUrl}/media?${params.toString()}` };
      }
      return m;
    });
    return { ...post, media: newMedia };
  });
}

async function loadFeed(feedId) {
  const gen = ++_loadGeneration;
  showLoading(true);

  try {
    let posts = await getUnreadPosts(feedId, 30);
    if (gen !== _loadGeneration) return;

    if (posts.length < 5) {
      posts = await fetchAndCache(feedId) ?? posts;
      if (gen !== _loadGeneration) return;
    }

    authorsMap = await getAuthorsMap();
    stack.load(rewriteVideoUrls(posts), feedId);
    updateRemainingBadge();
  } catch (err) {
    if (gen !== _loadGeneration) return;
    console.error('フィード読み込みエラー:', err);
    showToast('読み込みエラー: ' + (err?.message ?? err), 4000);
    const posts = await getUnreadPosts(feedId, 30);
    if (gen !== _loadGeneration) return;
    stack.load(rewriteVideoUrls(posts), feedId);
  } finally {
    if (gen === _loadGeneration) showLoading(false);
  }
}

async function fetchAndCache(feedId) {
  const feed = feeds.find(f => f.id === feedId);
  if (!feed) return null;

  const { tweets } = await fetchListTimeline({
    listId: feed.listId,
    authToken: settings.authToken,
    ct0: settings.ct0,
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

  // タブのactive切替 & スクロール
  document.querySelectorAll('.feed-tab').forEach(t => {
    const isActive = t.dataset.feedId === feedId;
    t.classList.toggle('active', isActive);
    if (isActive) t.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
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
      stack.load(rewriteVideoUrls(posts), currentFeedId);
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

    // 新形式(media)と旧形式(images)の両方をサポート
    const firstMedia = item.media?.[0];
    const thumbUrl = firstMedia?.poster || firstMedia?.url || item.images?.[0];
    const thumbHTML = thumbUrl
      ? `<img class="bookmark-thumb" src="${escHtml(thumbUrl)}" loading="lazy" alt="" onerror="this.outerHTML='<div class=\\'bookmark-thumb-placeholder\\'>📌</div>'">`
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

    // タップでカードプレビューを表示
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('bookmark-delete-btn')) return;
      showBookmarkCard(item);
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

// ────────────────────────────────────────────────────────────────
// カードプレビューモーダル
// ────────────────────────────────────────────────────────────────
let _bookmarkSwipeController = null;

function showBookmarkCard(item) {
  const modal = document.getElementById('card-preview-modal');
  const content = document.getElementById('card-preview-content');
  if (!modal || !content) return;

  // bookmarkのデータ構造（tweetId）をbuildCardHTMLが期待する形（id）に変換
  const tweetLike = { ...item, id: item.tweetId };
  content.innerHTML = buildCardHTML(tweetLike, item.feedId ?? '');
  modal.classList.remove('hidden');

  const cardEl = content.querySelector('.card');
  if (cardEl) bindBookmarkCardSwipe(cardEl);
}

function hideBookmarkCard() {
  _bookmarkSwipeController?.abort();
  _bookmarkSwipeController = null;
  document.getElementById('card-preview-modal')?.classList.add('hidden');
}

// カードをスワイプすると閉じる
function bindBookmarkCardSwipe(cardEl) {
  _bookmarkSwipeController?.abort();
  _bookmarkSwipeController = new AbortController();
  const { signal } = _bookmarkSwipeController;

  const THRESHOLD = 80;
  let startX = 0, startY = 0, dx = 0, dy = 0;
  let tracking = false;

  const shouldIgnore = (target) =>
    target.closest('a, button, video, .card-image-scroll, .card-media-video');

  cardEl.addEventListener('touchstart', (e) => {
    if (shouldIgnore(e.target)) return;
    const p = e.touches[0];
    startX = p.clientX;
    startY = p.clientY;
    dx = 0; dy = 0;
    tracking = true;
    cardEl.style.transition = 'none';
  }, { passive: true, signal });

  cardEl.addEventListener('touchmove', (e) => {
    if (!tracking) return;
    const p = e.touches[0];
    dx = p.clientX - startX;
    dy = p.clientY - startY;
    const rot = Math.max(-15, Math.min(15, dx / 20));
    cardEl.style.transform = `translate(${dx}px, ${dy}px) rotate(${rot}deg)`;
    cardEl.style.opacity = String(Math.max(0.4, 1 - Math.hypot(dx, dy) / 500));
  }, { passive: true, signal });

  const endHandler = () => {
    if (!tracking) return;
    tracking = false;
    const dist = Math.hypot(dx, dy);
    cardEl.style.transition = 'transform 0.28s cubic-bezier(0.2, 0.7, 0.3, 1), opacity 0.28s';

    if (dist > THRESHOLD) {
      const flyX = (dx / dist) * (window.innerWidth + 200);
      const flyY = (dy / dist) * (window.innerHeight + 200);
      const rot = Math.max(-30, Math.min(30, dx / 10));
      cardEl.style.transform = `translate(${flyX}px, ${flyY}px) rotate(${rot}deg)`;
      cardEl.style.opacity = '0';
      setTimeout(hideBookmarkCard, 260);
    } else {
      cardEl.style.transform = '';
      cardEl.style.opacity = '';
    }
    dx = 0; dy = 0;
  };

  cardEl.addEventListener('touchend', endHandler, { signal });
  cardEl.addEventListener('touchcancel', endHandler, { signal });
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
  document.getElementById('setting-ct0').value = settings.ct0 ?? '';
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
  const ct0         = document.getElementById('setting-ct0').value.trim();
  const workerUrl   = document.getElementById('setting-worker-url').value.trim();
  const proxySecret = document.getElementById('setting-proxy-secret').value.trim();

  if (!authToken || !ct0 || !workerUrl) {
    showToast('auth_token、ct0、Worker URL は必須です');
    return;
  }

  await Promise.all([
    setSetting('authToken',   authToken),
    setSetting('ct0',         ct0),
    setSetting('workerUrl',   workerUrl),
    setSetting('proxySecret', proxySecret),
    setSetting('feeds',       JSON.stringify(feeds)),
  ]);

  settings = { authToken, ct0, workerUrl, proxySecret, feeds: JSON.stringify(feeds) };
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

  scheduleBottomNavOffsetSync();
}

// ────────────────────────────────────────────────────────────────
// バックグラウンドスワイプでフィード切替
// ────────────────────────────────────────────────────────────────
function bindFeedSwipe() {
  let startX = 0, startY = 0, tracking = false;

  function isValidZone(target, clientY) {
    if (target.closest('button'))         return false;
    if (target.closest('.feed-tabs'))     return false;
    if (target.closest('.bottom-nav'))    return false;
    if (target.closest('.card-wrapper'))  return false;
    if (!target.closest('#screen-swipe')) return false;
    const csa = document.querySelector('.card-stack-area');
    if (csa && clientY <= csa.getBoundingClientRect().bottom) return false;
    return true;
  }

  document.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    if (!isValidZone(e.target, t.clientY)) return;
    startX = t.clientX;
    startY = t.clientY;
    tracking = true;
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    if (!tracking) return;
    tracking = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    if (Math.abs(dx) < 60) return;
    if (Math.abs(dx) < Math.abs(dy) * 1.5) return;
    const idx = feeds.findIndex(f => f.id === currentFeedId);
    if (dx < 0 && idx < feeds.length - 1) switchFeed(feeds[idx + 1].id);
    if (dx > 0 && idx > 0)                switchFeed(feeds[idx - 1].id);
  }, { passive: true });

  document.addEventListener('touchcancel', () => { tracking = false; }, { passive: true });
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
  const nav = document.querySelector('.bottom-nav');
  const navResizeObserver = ('ResizeObserver' in window && nav)
    ? new ResizeObserver(() => scheduleBottomNavOffsetSync())
    : null;

  navResizeObserver?.observe(nav);
  scheduleBottomNavOffsetSync();
  window.addEventListener('resize', scheduleBottomNavOffsetSync);
  window.addEventListener('pageshow', scheduleBottomNavOffsetSync);
  window.visualViewport?.addEventListener('resize', scheduleBottomNavOffsetSync);

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

  // カードプレビューモーダルを閉じる
  document.getElementById('card-preview-close')?.addEventListener('click', hideBookmarkCard);
  document.querySelector('.card-preview-backdrop')?.addEventListener('click', hideBookmarkCard);

  // 設定の保存
  document.getElementById('btn-save-settings')?.addEventListener('click', saveSettings);

  // エクスポート
  document.getElementById('btn-export')?.addEventListener('click', async () => {
    await exportBookmarks();
    showToast('JSONをダウンロードしました');
  });

  // デバッグ: カードをすべてクリア
  document.getElementById('btn-clear-posts')?.addEventListener('click', async () => {
    if (!confirm('取得済みツイートのキャッシュを削除して再取得します。\nlike・dismiss・ブックマーク履歴は残ります。よろしいですか？')) return;
    await clearPostsCache();
    showToast('クリアしました。フィードを再取得します…');
    await setupMainScreen();
    showScreen('swipe');
  });

  // デバッグ: Service Worker キャッシュをクリア
  document.getElementById('btn-clear-cache')?.addEventListener('click', async () => {
    if (!confirm('Service Worker のキャッシュをすべて削除してリロードします。よろしいですか？')) return;
    const keys = await caches.keys();
    await Promise.all(keys.map(k => caches.delete(k)));
    const reg = await navigator.serviceWorker.getRegistration();
    if (reg) await reg.update();
    showToast('キャッシュをクリアしました。リロードします…');
    setTimeout(() => location.reload(true), 800);
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
    const authToken   = document.getElementById('setup-auth-token').value.trim();
    const ct0         = document.getElementById('setup-ct0').value.trim();
    const workerUrl   = document.getElementById('setup-worker-url').value.trim();
    const proxySecret = document.getElementById('setup-proxy-secret').value.trim();
    if (!authToken || !ct0 || !workerUrl) {
      showToast('auth_token、ct0、Worker URL は必須です');
      return;
    }
    await Promise.all([
      setSetting('authToken',   authToken),
      setSetting('ct0',         ct0),
      setSetting('workerUrl',   workerUrl),
      setSetting('proxySecret', proxySecret),
    ]);
    settings.authToken   = authToken;
    settings.ct0         = ct0;
    settings.workerUrl   = workerUrl;
    settings.proxySecret = proxySecret;
    await setupMainScreen();
    showScreen('swipe');
  });

  // バックグラウンドスワイプでフィード切替
  bindFeedSwipe();

  // 起動
  await init();
});
