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
// カードのHTML生成
// ──────────────────────────────────────────────────────────────
function buildCardHTML(tweet, feedId, affinityCount = 0) {
  const handle = tweet.author?.handle ?? '';
  const name   = tweet.author?.name ?? handle;
  const avatar = tweet.author?.avatar ?? '';
  const time   = relativeTime(tweet.createdAt);
  const accentColor = FEED_COLORS[feedId] ?? FEED_COLORS.default;
  const hasImages = tweet.images?.length > 0;

  // 著者アフィニティインジケーター（liked 回数に応じて♥を表示）
  const hearts = affinityCount >= 3 ? '♥♥♥' : affinityCount === 2 ? '♥♥' : affinityCount === 1 ? '♥' : '';

  // 画像エリア
  let imagesHTML = '';
  if (hasImages) {
    if (tweet.images.length === 1) {
      imagesHTML = `
        <div class="card-image-single">
          <img src="${escHtml(tweet.images[0])}" alt="ツイート画像" loading="lazy" onerror="this.parentElement.style.display='none'">
        </div>`;
    } else {
      const imgs = tweet.images.map(url =>
        `<img src="${escHtml(url)}" alt="ツイート画像" loading="lazy" onerror="this.parentElement.style.display='none'">`
      ).join('');
      imagesHTML = `<div class="card-image-scroll">${imgs}</div>`;
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

      <!-- 画像 -->
      ${imagesHTML}

      <!-- 本文 -->
      <div class="card-body ${!hasImages ? 'card-body-full' : ''}">
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
    // 先頭から最大3枚をDOMに追加（逆順でZが奥→手前）
    const visible = this._tweets.slice(0, 3).reverse();
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
        w.style.opacity = '0.9';
      } else {
        w.style.transform = 'translate3d(0, 24px, 0) scale(0.92)';
        w.style.zIndex = '1';
        w.style.opacity = '0.75';
      }
    });
  }

  /** 下のカードをせり上がらせる（トップカード飛ばし後） */
  _promoteStack() {
    const wrappers = Array.from(this.el.querySelectorAll('.card-wrapper'));
    // 手前のカード（stackIndex=2）は既に飛んでいる → 残りを1段階前に
    wrappers.forEach(w => {
      const idx = parseInt(w.dataset.stackIndex);
      if (idx > 0) {
        w.dataset.stackIndex = String(idx - 1);
        const transition = 'transform 0.25s cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 0.25s ease';
        w.style.transition = transition;
        setTimeout(() => this._applyStackStyles(), 10);
      }
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
  }

  _onPointerDown(e) {
    // リンクのクリックは無視
    if (e.target.closest('a')) return;
    this._dragging = true;
    this._startX = e.clientX;
    this._startY = e.clientY;
    this._curX = 0;
    this._curY = 0;

    const wrapper = e.currentTarget;
    wrapper.setPointerCapture(e.pointerId);
    // ドラッグ中はtransitionを無効化してカクつきを防ぐ
    wrapper.style.transition = 'none';
    wrapper.style.willChange = 'transform';
  }

  _onPointerMove(e) {
    if (!this._dragging) return;

    this._curX = e.clientX - this._startX;
    this._curY = e.clientY - this._startY;

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
    if (!this._dragging) return;
    this._dragging = false;

    const dx = this._curX;
    const dy = this._curY;
    const wrapper = e.currentTarget;

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
    if (!this._dragging) return;
    this._dragging = false;
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
    wrapper.style.opacity = '0.75';
    wrapper.style.zIndex = '1';

    this.el.prepend(wrapper); // 一番下に追加

    // 追加後すぐに次のトップカードにジェスチャーをバインド
    setTimeout(() => this._bindTopCard(), 50);
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
