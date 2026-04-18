/**
 * swipe.js — カードスワイプUI
 *
 * 使い方:
 *   const stack = new CardStack('#card-stack', {
 *     onLike(tweet)     { ... },
 *     onDismiss(tweet)  { ... },
 *     onBookmark(tweet) { ... },
 *     onEmpty()         { ... },
 *   });
 *   stack.load(tweets);
 */

// ──────────────────────────────────────────────────────────────
// オンスクリーンデバッグログ (?debug=1 で有効)
// ──────────────────────────────────────────────────────────────
const _debugEnabled = new URLSearchParams(location.search).has('debug');
const _dbgLog = (() => {
  if (!_debugEnabled) return () => {};
  const panel = document.createElement('div');
  Object.assign(panel.style, {
    position: 'fixed', top: '0', left: '0', right: '0',
    maxHeight: '45vh', overflowY: 'auto',
    background: 'rgba(0,0,0,0.82)', color: '#0f0', fontSize: '11px',
    fontFamily: 'monospace', padding: '4px', zIndex: '99999',
    pointerEvents: 'none', wordBreak: 'break-all',
  });
  const append = () => {
    document.body.appendChild(panel);
    const init = document.createElement('div');
    init.textContent = '[DEBUG MODE ON] tap an image to test';
    panel.appendChild(init);
  };
  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', append)
    : append();
  let seq = 0;
  return (label, data = {}) => {
    const t = (performance.now() / 1000).toFixed(2);
    const parts = [`[${t}] #${++seq} ${label}`];
    for (const [k, v] of Object.entries(data)) parts.push(`${k}=${v}`);
    const line = document.createElement('div');
    line.textContent = parts.join(' | ');
    panel.appendChild(line);
    if (panel.children.length > 60) panel.firstChild.remove();
    panel.scrollTop = panel.scrollHeight;
  };
})();

// ──────────────────────────────────────────────────────────────
// 定数
// ──────────────────────────────────────────────────────────────
const THRESHOLD_X = 110;   // px: 左右スワイプ確定閾値
const THRESHOLD_Y = -90;   // px: 上スワイプ確定閾値（負値）
const FLY_DURATION = 320;  // ms: カードが飛んでいくアニメーション時間
const MAX_ROTATE = 18;     // deg: ドラッグ端での最大回転角

// フィードカテゴリのアクセントカラー（カード背景に使用）
const FEED_COLORS = {
  tech:    '#1a2744',
  games:   '#1a2a1a',
  toys:    '#2a1a2a',
  gadgets: '#1a2030',
  books:   '#2a2010',
  foods:   '#2a1810',
  friends: '#102a2a',
  etc:     '#1a1a2a',
  default: '#1c1c1e',
};

// ──────────────────────────────────────────────────────────────
// 相対時間
// ──────────────────────────────────────────────────────────────
function relativeTime(createdAt) {
  const ms = Date.now() - new Date(createdAt).getTime();
  const s = ms / 1000;
  if (s < 60)        return 'たった今';
  const m = s / 60;
  if (m < 60)        return `${Math.floor(m)}分前`;
  const h = m / 60;
  if (h < 24)        return `${Math.floor(h)}時間前`;
  const d = h / 24;
  if (d < 7)         return `${Math.floor(d)}日前`;
  return new Date(createdAt).toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' });
}

// ──────────────────────────────────────────────────────────────
// メディアアイテム単体のHTML生成
// ──────────────────────────────────────────────────────────────
function buildMediaItemHTML(m) {
  if (m.type === 'photo') {
    return `<img src="${escHtml(m.url)}" alt="ツイート画像" loading="lazy" draggable="false" onerror="this.style.display='none'">`;
  }
  // video / animated_gif: 初期はポスター画像+再生ボタン、タップで<video>に置換
  const badge = m.type === 'animated_gif' ? '<span class="card-media-badge">GIF</span>' : '';
  return `
    <div class="card-media-video" data-video-url="${escHtml(m.url)}" data-video-poster="${escHtml(m.poster)}">
      <img class="card-video-poster" src="${escHtml(m.poster)}" alt="動画サムネイル" loading="lazy" onerror="this.style.display='none'">
      <button class="card-video-play" aria-label="動画を再生" type="button">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12L4 2v20l17-10z"/></svg>
      </button>
      ${badge}
    </div>`;
}

// ──────────────────────────────────────────────────────────────
// カードのHTML生成
// ──────────────────────────────────────────────────────────────
export function buildCardHTML(tweet, feedId, affinityCount = 0) {
  const handle = tweet.author?.handle ?? '';
  const name   = tweet.author?.name ?? handle;
  const avatar = tweet.author?.avatar ?? '';
  const time   = relativeTime(tweet.createdAt);
  const accentColor = FEED_COLORS[feedId] ?? FEED_COLORS.default;

  // メディア配列を取得（旧形式 images との互換シム）
  const media = tweet.media
    || (tweet.images?.length ? tweet.images.map(url => ({ type: 'photo', url })) : []);
  const hasMedia = media.length > 0;

  // 著者アフィニティインジケーター（liked 回数に応じて♥を表示）
  const hearts = affinityCount >= 3 ? '♥♥♥' : affinityCount === 2 ? '♥♥' : affinityCount === 1 ? '♥' : '';

  // メディアエリア
  let mediaHTML = '';
  if (hasMedia) {
    if (media.length === 1) {
      mediaHTML = `<div class="card-image-single">${buildMediaItemHTML(media[0])}</div>`;
    } else {
      const items = media.map(m => buildMediaItemHTML(m)).join('');
      mediaHTML = `<div class="card-image-scroll">${items}</div>`;
    }
  }

  // 引用ツイート
  let quoteHTML = '';
  if (tweet.quotedTweet?.text) {
    quoteHTML = `
      <div class="card-quote">
        <span class="card-quote-author">@${escHtml(tweet.quotedTweet.author ?? '')}</span>
        <p class="card-quote-text">${escHtml(truncate(tweet.quotedTweet.text, 120))}</p>
      </div>`;
  }

  // テキスト（URLを除去してすっきり表示）
  const displayText = stripUrls(tweet.text ?? '');

  return `
    <div class="card" data-tweet-id="${escHtml(tweet.id)}" style="--accent:${accentColor}">
      <!-- スワイプオーバーレイ（方向インジケーター） -->
      <div class="card-overlay like"  aria-hidden="true"><span>♥</span></div>
      <div class="card-overlay skip"  aria-hidden="true"><span>✕</span></div>
      <div class="card-overlay save"  aria-hidden="true"><span>★</span></div>

      <!-- リポストインジケーター -->
      ${tweet.retweetedBy ? `<div class="card-retweet-bar">↺ <span>@${escHtml(tweet.retweetedBy)}</span> がリポスト</div>` : ''}

      <!-- ヘッダー：著者情報 -->
      <div class="card-header">
        <div class="card-author">
          ${avatar ? `<img class="card-avatar" src="${escHtml(avatar)}" alt="${escHtml(name)}" loading="lazy">` : `<div class="card-avatar card-avatar-placeholder"></div>`}
          <div class="card-author-info">
            <span class="card-author-name">${escHtml(name)}</span>
            <span class="card-author-handle">@${escHtml(handle)}</span>
          </div>
        </div>
        ${hearts ? `<span class="card-hearts" aria-label="${affinityCount}回いいねした著者">${hearts}</span>` : ''}
      </div>

      <!-- メディア（画像 / 動画 / GIF） -->
      ${mediaHTML}

      <!-- 本文 -->
      <div class="card-body ${!hasMedia ? 'card-body-full' : ''}">
        ${displayText ? `<p class="card-text">${escHtml(displayText)}</p>` : ''}
        ${quoteHTML}
      </div>

      <!-- フッター -->
      <div class="card-footer">
        <span class="card-feed-tag">${escHtml(feedId)}</span>
        <span class="card-time">${time}</span>
        <a class="card-link" href="${escHtml(tweet.link)}" target="_blank" rel="noopener" aria-label="元のツイートを開く">↗</a>
      </div>
    </div>`;
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncate(str, len) {
  return str.length > len ? str.slice(0, len) + '…' : str;
}

function stripUrls(str) {
  return str.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
}

// ──────────────────────────────────────────────────────────────
// 画像ビューアー（ライトボックス）
// ──────────────────────────────────────────────────────────────
function openImageViewer(url) {
  _dbgLog('openImageViewer CALLED', { url: url.slice(-30) });
  const overlay = document.createElement('div');
  overlay.className = 'img-viewer';
  overlay.innerHTML = `<img class="img-viewer-img" src="${escHtml(url)}" alt="拡大表示" draggable="false">`;
  document.body.appendChild(overlay);
  _dbgLog('overlay appended', { zIndex: getComputedStyle(overlay).zIndex, display: getComputedStyle(overlay).display });

  const img = overlay.querySelector('.img-viewer-img');
  requestAnimationFrame(() => overlay.classList.add('open'));

  let scale = 1;
  let tx = 0;
  let ty = 0;
  const pts = new Map();
  let lastDist = null;
  let lastTap = 0;
  let tapTimer = null;
  let startX = 0;
  let startY = 0;
  let startTX = 0;
  let startTY = 0;
  let moved = false;
  const openedAt = Date.now();

  function apply(animated = false) {
    img.style.transition = animated ? 'transform 0.22s ease' : 'none';
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  }

  function clamp() {
    if (scale <= 1) { tx = 0; ty = 0; return; }
    const maxX = (overlay.clientWidth  * (scale - 1)) / 2;
    const maxY = (overlay.clientHeight * (scale - 1)) / 2;
    tx = Math.max(-maxX, Math.min(maxX, tx));
    ty = Math.max(-maxY, Math.min(maxY, ty));
  }

  function close() {
    overlay.classList.remove('open');
    setTimeout(() => overlay.remove(), 250);
  }

  overlay.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    // Androidでは pointerup 後に合成マウスイベントが発火してビューアを即閉じてしまう。
    // 開いた直後 350ms 以内のイベントは無視する。
    if (Date.now() - openedAt < 350) return;
    overlay.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) {
      startX = e.clientX;
      startY = e.clientY;
      startTX = tx;
      startTY = ty;
      moved = false;
      lastDist = null;
    }
  });

  overlay.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pts.size === 2) {
      const [p1, p2] = [...pts.values()];
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      if (lastDist !== null) {
        scale = Math.max(1, Math.min(5, scale * dist / lastDist));
        clamp();
        apply();
      }
      lastDist = dist;
      moved = true;
    } else {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (Math.abs(dx) > 5 || Math.abs(dy) > 5) moved = true;
      if (scale > 1) {
        tx = startTX + dx;
        ty = startTY + dy;
        apply();
      }
    }
  });

  overlay.addEventListener('pointerup', (e) => {
    pts.delete(e.pointerId);
    if (pts.size > 0) { lastDist = null; return; }
    lastDist = null;

    const dy = e.clientY - startY;

    if (!moved) {
      const now = Date.now();
      if (now - lastTap < 280) {
        clearTimeout(tapTimer);
        lastTap = 0;
        if (scale > 1) { scale = 1; tx = 0; ty = 0; }
        else { scale = 2.5; }
        apply(true);
      } else {
        lastTap = now;
        tapTimer = setTimeout(() => {
          if (scale <= 1) close();
        }, 280);
      }
    } else if (scale <= 1 && dy > 80) {
      close();
    } else {
      clamp();
      apply(true);
    }
  });

  overlay.addEventListener('pointercancel', (e) => {
    pts.delete(e.pointerId);
    lastDist = null;
  });
}

// ──────────────────────────────────────────────────────────────
// CardStack クラス
// ──────────────────────────────────────────────────────────────
export class CardStack {
  /**
   * @param {string|Element} container - カードスタックを配置する要素
   * @param {object} callbacks
   * @param {Function} callbacks.onLike
   * @param {Function} callbacks.onDismiss
   * @param {Function} callbacks.onBookmark
   * @param {Function} [callbacks.onEmpty]
   * @param {Function} [callbacks.getAffinity] - (handle) => likeCount
   */
  constructor(container, callbacks = {}) {
    this.el = typeof container === 'string' ? document.querySelector(container) : container;
    if (!this.el) throw new Error('CardStack: container not found');

    this.callbacks = callbacks;
    this._tweets = [];        // 表示待ちツイートの配列
    this._feedId = 'default'; // 現在のフィードID
    this._dragging = false;
    this._startX = 0;
    this._startY = 0;
    this._curX = 0;
    this._curY = 0;
    this._activeCard = null;

    this._bindButtons();
  }

  // ────────────────────────────────
  // 公開メソッド
  // ────────────────────────────────

  /**
   * カードデータをロードして描画する。
   * @param {object[]} tweets
   * @param {string} feedId
   */
  load(tweets, feedId = 'default') {
    this._tweets = [...tweets];
    this._feedId = feedId;
    this._render();
  }

  /**
   * 末尾に追加（無限スクロール用）。
   */
  append(tweets) {
    this._tweets.push(...tweets);
    this._renderIfNeeded();
  }

  /** 残りカード枚数 */
  get remaining() {
    return this._tweets.length;
  }

  // ────────────────────────────────
  // 描画
  // ────────────────────────────────

  _render() {
    this.el.innerHTML = '';
    if (this._tweets.length === 0) {
      this._showEmpty();
      return;
    }
    // 先頭から最大3枚をDOMに追加（tweets[0]が手前=stackIndex 2）
    const visible = this._tweets.slice(0, 3);
    visible.forEach((tweet, i) => {
      const wrapper = document.createElement('div');
      wrapper.className = 'card-wrapper';
      wrapper.dataset.stackIndex = String(2 - i); // 0=奥, 2=手前
      const affinity = this.callbacks.getAffinity?.(tweet.author?.handle) ?? 0;
      wrapper.innerHTML = buildCardHTML(tweet, this._feedId, affinity);
      this.el.appendChild(wrapper);
    });
    this._applyStackStyles();
    this._bindTopCard();
  }

  _renderIfNeeded() {
    const wrappers = this.el.querySelectorAll('.card-wrapper');
    if (wrappers.length === 0 && this._tweets.length > 0) {
      this._render();
    }
  }

  /** スタックの視覚的な位置付け */
  _applyStackStyles() {
    const wrappers = Array.from(this.el.querySelectorAll('.card-wrapper'));
    wrappers.forEach(w => {
      const idx = parseInt(w.dataset.stackIndex);
      w.style.transition = '';
      if (idx === 2) { // 手前（アクティブ）
        w.style.transform = 'translate3d(0, 0, 0) scale(1)';
        w.style.zIndex = '3';
        w.style.opacity = '1';
      } else if (idx === 1) {
        w.style.transform = 'translate3d(0, 12px, 0) scale(0.96)';
        w.style.zIndex = '2';
        w.style.opacity = '1';
      } else {
        w.style.transform = 'translate3d(0, 24px, 0) scale(0.92)';
        w.style.zIndex = '1';
        w.style.opacity = '1';
      }
    });
  }

  /** 下のカードをせり上がらせる（トップカード飛ばし後） */
  _promoteStack() {
    const wrappers = Array.from(this.el.querySelectorAll('.card-wrapper'));
    const transition = 'transform 0.25s cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 0.25s ease';
    // 残りカードを全て1段階手前に昇格（index+1）
    wrappers.forEach(w => {
      w.dataset.stackIndex = String(parseInt(w.dataset.stackIndex) + 1);
      w.style.transition = transition;
    });
    setTimeout(() => this._applyStackStyles(), 10);
  }

  /** 長押しコンテキストメニューを表示 */
  _showCardMenu(wrapper) {
    // 既存メニューを閉じる
    document.querySelector('.card-context-menu')?.remove();

    const tweetId = wrapper.querySelector('.card')?.dataset.tweetId;
    const tweet = this._tweets.find(t => t.id === tweetId);
    if (!tweet) return;

    const menu = document.createElement('div');
    menu.className = 'card-context-menu';
    menu.innerHTML = `
      <ul>
        <li data-action="open-tweet">元のツイートを開く ↗</li>
      </ul>`;

    wrapper.appendChild(menu);
    requestAnimationFrame(() => menu.classList.add('visible'));

    // メニュー外タップで閉じる
    const close = (e) => {
      if (!menu.contains(e.target)) {
        menu.classList.remove('visible');
        setTimeout(() => menu.remove(), 150);
        document.removeEventListener('pointerdown', close);
      }
    };
    setTimeout(() => document.addEventListener('pointerdown', close), 0);

    menu.querySelector('[data-action="open-tweet"]').addEventListener('click', () => {
      window.open(tweet.link, '_blank', 'noopener');
      menu.classList.remove('visible');
      setTimeout(() => menu.remove(), 150);
    });
  }

  _showEmpty() {
    this.el.innerHTML = `
      <div class="card-empty">
        <p class="card-empty-icon">✓</p>
        <p class="card-empty-text">全部チェックしました</p>
        <p class="card-empty-sub">次の更新をお待ちください</p>
      </div>`;
    this.callbacks.onEmpty?.();
  }

  // ────────────────────────────────
  // ジェスチャー
  // ────────────────────────────────

  _bindTopCard() {
    const topWrapper = this.el.querySelector('[data-stack-index="2"]');
    if (!topWrapper) return;
    this._activeCard = topWrapper;

    topWrapper.addEventListener('pointerdown', this._onPointerDown.bind(this));
    topWrapper.addEventListener('pointermove', this._onPointerMove.bind(this));
    topWrapper.addEventListener('pointerup',   this._onPointerUp.bind(this));
    topWrapper.addEventListener('pointercancel', this._onPointerCancel.bind(this));
    topWrapper.addEventListener('gotpointercapture',  (e) => _dbgLog('gotpointercapture',  { id: e.pointerId }));
    topWrapper.addEventListener('lostpointercapture', (e) => _dbgLog('lostpointercapture', { id: e.pointerId }));

    // 画像タップでビューアーを開く（click はポインターキャプチャの影響を受けない）
    topWrapper.querySelectorAll('.card-image-single img, .card-image-scroll img').forEach(img => {
      img.addEventListener('click', (e) => {
        e.stopPropagation();
        openImageViewer(img.src);
      });
    });

    // 動画再生ボタン
    topWrapper.querySelectorAll('.card-video-play').forEach(btn => {
      btn.addEventListener('click', this._onVideoPlayClick.bind(this));
    });
  }

  _onVideoPlayClick(e) {
    e.stopPropagation();
    const btn = e.currentTarget;
    const container = btn.closest('.card-media-video');
    if (!container) return;
    const url = container.dataset.videoUrl;
    const poster = container.dataset.videoPoster;

    container.querySelector('.card-video-poster')?.remove();
    btn.remove();

    const video = document.createElement('video');
    video.src = url;
    video.poster = poster;
    video.playsInline = true;
    video.controls = true;
    video.autoplay = true;
    video.className = 'card-video-el';
    video.addEventListener('error', () => {
      const err = video.error;
      console.error('video load error', {
        src: url,
        code: err?.code,
        message: err?.message,
      });
    });
    container.appendChild(video);

    video.play().catch(err => console.warn('video play failed', err));
  }

  _onPointerDown(e) {
    _dbgLog('pointerdown', {
      type: e.pointerType, tag: e.target.tagName,
      cls: (e.target.className+'').slice(0,30),
      x: e.clientX|0, y: e.clientY|0,
    });
    // リンク・動画再生ボタンのクリックは無視
    if (e.target.closest('a')) { _dbgLog('→ early-return:a'); return; }
    if (e.target.closest('.card-video-play')) { _dbgLog('→ early-return:video-play'); return; }
    if (e.target.closest('.card-video-el')) { _dbgLog('→ early-return:video-el'); return; }
    this._startTarget = e.target;
    this._dragging = true;
    this._startX = e.clientX;
    this._startY = e.clientY;
    this._curX = 0;
    this._curY = 0;
    this._longPressActive = false;

    const wrapper = e.currentTarget;
    wrapper.setPointerCapture(e.pointerId);
    _dbgLog('setPointerCapture', { hasCap: wrapper.hasPointerCapture(e.pointerId) });
    // ドラッグ中はtransitionを無効化してカクつきを防ぐ
    wrapper.style.transition = 'none';
    wrapper.style.willChange = 'transform';

    // 長押し検出（500ms）
    this._longPressTimer = setTimeout(() => {
      if (!this._dragging) return;
      this._longPressActive = true;
      this._dragging = false;
      this._returnCard(wrapper);
      navigator.vibrate?.(30);
      this._showCardMenu(wrapper);
    }, 500);
  }

  _onPointerMove(e) {
    if (!this._dragging) return;

    this._curX = e.clientX - this._startX;
    this._curY = e.clientY - this._startY;

    // 10px以上動いたら長押しキャンセル
    if (this._longPressTimer && (Math.abs(this._curX) > 10 || Math.abs(this._curY) > 10)) {
      clearTimeout(this._longPressTimer);
      this._longPressTimer = null;
    }

    const dx = this._curX;
    const dy = this._curY;
    const rotate = (dx / window.innerWidth) * MAX_ROTATE;
    const wrapper = e.currentTarget;

    wrapper.style.transform = `translate3d(${dx}px, ${dy}px, 0) rotate(${rotate}deg)`;

    // オーバーレイの表示
    const card = wrapper.querySelector('.card');
    const overlayLike  = card.querySelector('.card-overlay.like');
    const overlaySkip  = card.querySelector('.card-overlay.skip');
    const overlaySave  = card.querySelector('.card-overlay.save');

    const absX = Math.abs(dx);
    const absY = Math.abs(dy);

    if (dy < THRESHOLD_Y && absX < 80) {
      // 上スワイプ（bookmark）
      overlaySave.style.opacity = Math.min(1, Math.abs(dy) / 100);
      overlayLike.style.opacity = '0';
      overlaySkip.style.opacity = '0';
    } else if (dx > 40) {
      overlayLike.style.opacity = Math.min(1, dx / THRESHOLD_X);
      overlaySkip.style.opacity = '0';
      overlaySave.style.opacity = '0';
    } else if (dx < -40) {
      overlaySkip.style.opacity = Math.min(1, -dx / THRESHOLD_X);
      overlayLike.style.opacity = '0';
      overlaySave.style.opacity = '0';
    } else {
      overlayLike.style.opacity = '0';
      overlaySkip.style.opacity = '0';
      overlaySave.style.opacity = '0';
    }
  }

  _onPointerUp(e) {
    clearTimeout(this._longPressTimer);
    this._longPressTimer = null;
    _dbgLog('pointerup', {
      type: e.pointerType, tag: e.target.tagName,
      dx: this._curX|0, dy: this._curY|0,
      startTag: this._startTarget?.tagName,
      dragging: this._dragging,
    });
    if (!this._dragging) return; // 長押し発動済みならスワイプしない
    this._dragging = false;

    const dx = this._curX;
    const dy = this._curY;
    const wrapper = e.currentTarget;

    // 画像タップ: ビューアーを開く
    if (Math.abs(dx) < 12 && Math.abs(dy) < 12) {
      const t = this._startTarget;
      _dbgLog('tap-check', { startTag: t?.tagName, inImgContainer: !!(t?.closest('.card-image-single, .card-image-scroll')) });
      if (t?.tagName === 'IMG' && t.closest('.card-image-single, .card-image-scroll')) {
        this._returnCard(wrapper);
        openImageViewer(t.src);
        return;
      }
    }

    if (dy < THRESHOLD_Y && Math.abs(dx) < 80) {
      this._flyCard(wrapper, 'bookmark');
    } else if (dx > THRESHOLD_X) {
      this._flyCard(wrapper, 'like');
    } else if (dx < -THRESHOLD_X) {
      this._flyCard(wrapper, 'dismiss');
    } else {
      this._returnCard(wrapper);
    }
  }

  _onPointerCancel(e) {
    clearTimeout(this._longPressTimer);
    this._longPressTimer = null;
    _dbgLog('pointercancel', {
      type: e.pointerType, tag: e.target.tagName,
      dx: this._curX|0, dy: this._curY|0,
      startTag: this._startTarget?.tagName,
      dragging: this._dragging,
    });
    if (!this._dragging) return;
    this._dragging = false;

    // iOS は画像タッチを pointercancel でキャンセルすることがある。
    // 移動量が小さければタップとして扱う。
    if (Math.abs(this._curX) < 15 && Math.abs(this._curY) < 15) {
      const t = this._startTarget;
      _dbgLog('cancel-tap-check', { startTag: t?.tagName, inImgContainer: !!(t?.closest('.card-image-single, .card-image-scroll')) });
      if (t?.tagName === 'IMG' && t.closest('.card-image-single, .card-image-scroll')) {
        this._returnCard(e.currentTarget);
        openImageViewer(t.src);
        return;
      }
    }

    this._returnCard(e.currentTarget);
  }

  // ────────────────────────────────
  // アニメーション
  // ────────────────────────────────

  /** カードを元の位置に戻す */
  _returnCard(wrapper) {
    wrapper.style.transition = `transform 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94)`;
    wrapper.style.transform = 'translate3d(0, 0, 0) rotate(0deg)';
    wrapper.style.willChange = '';
    // オーバーレイを消す
    wrapper.querySelectorAll('.card-overlay').forEach(o => o.style.opacity = '0');
  }

  /** カードを画面外に飛ばしてアクションを実行 */
  _flyCard(wrapper, action) {
    const tweetId = wrapper.querySelector('.card')?.dataset.tweetId;
    const tweet = this._tweets.find(t => t.id === tweetId);
    if (!tweet) return;

    let tx, ty, rot;
    if (action === 'like') {
      tx = window.innerWidth * 1.5; ty = -50; rot = MAX_ROTATE;
    } else if (action === 'dismiss') {
      tx = -window.innerWidth * 1.5; ty = -50; rot = -MAX_ROTATE;
    } else {
      // bookmark: 上へ
      tx = 0; ty = -window.innerHeight * 1.2; rot = 0;
    }

    wrapper.style.transition = `transform ${FLY_DURATION}ms cubic-bezier(0.3, 0.5, 0.7, 1.0), opacity ${FLY_DURATION}ms ease`;
    wrapper.style.transform = `translate3d(${tx}px, ${ty}px, 0) rotate(${rot}deg)`;
    wrapper.style.opacity = '0';
    wrapper.style.pointerEvents = 'none';

    // ハプティクスフィードバック
    navigator.vibrate?.(action === 'bookmark' ? [10, 50, 10] : 10);

    // アニメーション完了後
    setTimeout(() => {
      wrapper.remove();
      this._tweets.shift(); // 先頭を取り出す
      this._promoteStack();

      // 3枚未満になったら新しいカードを追加
      const wrappers = this.el.querySelectorAll('.card-wrapper');
      if (wrappers.length < 3 && this._tweets.length > wrappers.length) {
        this._addCardToBack();
      }

      // 新しいトップカードにジェスチャーをバインド
      setTimeout(() => this._bindTopCard(), 60);

      if (this._tweets.length === 0) {
        setTimeout(() => this._showEmpty(), 50);
      }
    }, FLY_DURATION);

    // コールバック呼び出し
    if (action === 'like')     this.callbacks.onLike?.(tweet);
    if (action === 'dismiss')  this.callbacks.onDismiss?.(tweet);
    if (action === 'bookmark') this.callbacks.onBookmark?.(tweet);
  }

  /** スタックの一番後ろに新しいカードを追加 */
  _addCardToBack() {
    const existingCount = this.el.querySelectorAll('.card-wrapper').length;
    const nextTweet = this._tweets[existingCount];
    if (!nextTweet) return;

    const wrapper = document.createElement('div');
    wrapper.className = 'card-wrapper';
    wrapper.dataset.stackIndex = '0';
    const affinity = this.callbacks.getAffinity?.(nextTweet.author?.handle) ?? 0;
    wrapper.innerHTML = buildCardHTML(nextTweet, this._feedId, affinity);
    wrapper.style.transform = 'translate3d(0, 24px, 0) scale(0.92)';
    wrapper.style.opacity = '1';
    wrapper.style.zIndex = '1';

    this.el.prepend(wrapper); // 一番下に追加
  }

  // ────────────────────────────────
  // アクションボタン
  // ────────────────────────────────

  _bindButtons() {
    // ボタンはcard-stackの外側にある想定（app.jsで配置）
    // イベントはカスタムイベントで受け取る
    document.addEventListener('swipe-action', (e) => {
      const { action } = e.detail;
      const topWrapper = this.el.querySelector('[data-stack-index="2"]');
      if (topWrapper) this._flyCard(topWrapper, action);
    });
  }
}

/** アクションボタンからスワイプを発火する（app.js から呼ぶ） */
export function triggerSwipeAction(action) {
  document.dispatchEvent(new CustomEvent('swipe-action', { detail: { action } }));
}
