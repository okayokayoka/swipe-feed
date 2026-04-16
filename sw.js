/**
 * sw.js — Service Worker（最小限のシェルキャッシュ）
 *
 * 目的: PWAインストールプロンプトを有効にするための最小要件を満たすこと。
 * オフライン機能は不要（データはAPIから取得が前提）なので、
 * アプリシェル（HTML/CSS/JS）のみキャッシュする。
 */

const CACHE_NAME = 'swipe-app-v3';
const SHELL_ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/api.js',
  './js/db.js',
  './js/swipe.js',
  './manifest.json',
  './icons/icon.svg',
];

// インストール: シェルをキャッシュ
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_ASSETS))
  );
  // 待機をスキップして即座にアクティブ化
  self.skipWaiting();
});

// アクティベート: 古いキャッシュを削除
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// フェッチ: シェルはキャッシュ優先、APIリクエストはネットワークのみ
// バックグラウンド更新は cache:'reload' で CDN キャッシュをバイパス
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 別オリジン（APIコール等）はキャッシュしない
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      // キャッシュがあればそれを返し、バックグラウンドで更新（Stale-While-Revalidate）
      if (cached) {
        const freshReq = new Request(event.request, { cache: 'reload' });
        const update = fetch(freshReq).then(resp => {
          if (resp.ok) {
            caches.open(CACHE_NAME).then(c => c.put(event.request, resp.clone()));
          }
          return resp;
        }).catch(() => {});
        void update;
        return cached;
      }
      // キャッシュなし（クリア直後）: CDN をバイパスして最新を取得
      return fetch(new Request(event.request, { cache: 'reload' }));
    })
  );
});
