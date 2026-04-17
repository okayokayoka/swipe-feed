/**
 * sw.js — Service Worker（最小限のシェルキャッシュ）
 *
 * 目的: PWAインストールプロンプトを有効にするための最小要件を満たすこと。
 * オフライン機能は不要（データはAPIから取得が前提）なので、
 * アプリシェル（HTML/CSS/JS）のみキャッシュする。
 */

const CACHE_NAME = 'swipe-app-v7';

// インストール: 即座にアクティブ化のみ（キャッシュはフェッチ時に構築）
self.addEventListener('install', (event) => {
  self.skipWaiting();
});

// アクティベート: 古いキャッシュを削除
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// フェッチ: ネットワーク優先、失敗時のみキャッシュにフォールバック
// → 常に最新の JS/CSS を配信。オフライン時のみキャッシュを使用
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 別オリジン（APIコール等）はキャッシュしない
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(new Request(event.request, { cache: 'no-cache' }))
      .then(resp => {
        if (resp.ok) {
          caches.open(CACHE_NAME).then(c => c.put(event.request, resp.clone()));
        }
        return resp;
      })
      .catch(() => caches.match(event.request))
  );
});
