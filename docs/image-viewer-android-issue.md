# 画像ビューアが Android で起動しない問題（未解決・Codex 引き継ぎ用）

## 概要

SwipeFeed（X タイムラインを Tinder 風カードでスワイプする PWA）に画像タップで開く
ライトボックス（拡大ビューア）を実装したが、**実機 Android（Chrome）でだけ動かない**。

- **PC ブラウザ（デスクトップ Chrome）**: 動作する ✓
- **Chrome DevTools のモバイル UA + touch エミュレーション**: スクリプトでイベントを
  dispatch すると動作する ✓（が、これは合成イベントなので Android の実挙動とは別物）
- **実機 Android Chrome**: 動かない ✗
- **iOS は未確認**（ユーザは Android のみ所持）

ユーザは何度もキャッシュクリアして再現を確認しており、コードが反映されていないという
線は薄い。

## 期待動作

- カード上の画像（`.card-image-single img` または `.card-image-scroll img`）をタップ
- 全画面のライトボックス（`.img-viewer`）が `position:fixed; inset:0; z-index:1000` で
  オーバーレイし、画像が画面いっぱいに表示される
- ピンチで 1〜5 倍ズーム、ダブルタップで 2.5 倍 ↔ 1 倍トグル、シングルタップで閉じる、
  下スワイプで閉じる

## 関連ファイル

- `js/swipe.js`
  - `buildMediaItemHTML(m)` — `<img draggable="false" ...>` を生成
  - `openImageViewer(url)` — ライトボックス本体（pinch / double-tap / drag-to-close）
  - `class CardStack` の `_onPointerDown` / `_onPointerUp` / `_onPointerCancel` —
    カードの swipe ジェスチャー処理。画像タップ判定もここで行う
- `css/style.css`
  - `.card-image-single img` / `.card-image-scroll img` — `-webkit-touch-callout: none`
    などを付与
  - `.img-viewer` / `.img-viewer-img` — オーバーレイのスタイル
  - `[data-stack-index="2"] { touch-action: none; }` — 最前面カード（インタラクティブ）
    にのみ touch-action: none を適用
  - `.card-image-scroll { touch-action: pan-x; }` — 複数画像横スクロール用

## 現在のアーキテクチャ

```
.card-stack
  └─ .card-wrapper[data-stack-index="2"]   ← touch-action: none + pointer 4種をリッスン
       └─ .card
            ├─ .card-image-single
            │    └─ <img draggable="false" -webkit-touch-callout:none ...>
            └─ .card-image-scroll  (touch-action: pan-x)
                 └─ <img draggable="false" ...>
```

`_onPointerDown` で `wrapper.setPointerCapture(e.pointerId)` を呼び、以降の
pointer イベントはすべて wrapper に届く（はず）。`_startTarget = e.target` で
タップ開始位置の DOM 要素を保存し、`_onPointerUp` / `_onPointerCancel` で
「移動量が小さく、`_startTarget` が画像」なら `openImageViewer(t.src)` を呼ぶ。

## これまでに試した対処（全て失敗）

### 1. `_onPointerUp` で画像タップ判定（最初の実装）

```js
if (Math.abs(dx) < 12 && Math.abs(dy) < 12) {
  const t = this._startTarget;
  if (t?.tagName === 'IMG' && t.closest('.card-image-single, .card-image-scroll')) {
    this._returnCard(wrapper);
    openImageViewer(t.src);
    return;
  }
}
```

- PC では動作。Android では効かず。

### 2. `img` に `click` リスナーを追加（バックアップ）

```js
topWrapper.querySelectorAll('.card-image-single img, .card-image-scroll img').forEach(img => {
  img.addEventListener('click', (e) => {
    e.stopPropagation();
    openImageViewer(img.src);
  });
});
```

- 効かず。`setPointerCapture` により `click` が wrapper にリダイレクトされ、img の
  click ハンドラが発火しないことを Chrome で確認済み（PC では）。

### 3. `_onPointerCancel` に画像タップフォールバック追加

iOS は画像タッチで `pointerup` の代わりに `pointercancel` を送るとの仮説で実装。

```js
_onPointerCancel(e) {
  ...
  if (Math.abs(this._curX) < 15 && Math.abs(this._curY) < 15) {
    const t = this._startTarget;
    if (t?.tagName === 'IMG' && t.closest('.card-image-single, .card-image-scroll')) {
      this._returnCard(e.currentTarget);
      openImageViewer(t.src);
      return;
    }
  }
  this._returnCard(e.currentTarget);
}
```

- 効かず。

### 4. CSS で iOS タッチ挙動を抑制

```css
.card-image-single img, .card-image-scroll img {
  -webkit-touch-callout: none;
  user-select: none;
  -webkit-user-drag: none;
}
```

- 効かず。

### 5. `<img draggable="false">` を付与

- 効かず。

### 6. `openImageViewer` に `openedAt` ガード追加（直近の修正）

「Android では `pointerup` 後に合成マウスイベントが発火し、新しく作られた overlay の
pointerdown ハンドラが反応してシングルタップとして閉じるのでは？」という仮説で実装。

```js
const openedAt = Date.now();
overlay.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  if (Date.now() - openedAt < 350) return; // 合成イベントを無視
  ...
});
```

- 効かず。**そもそもビューア自体が開いていない可能性が高い**（ユーザの主観では「動か
  ない」としか分からないので、開いて即閉じているのか、開いてすらいないのか不明）。

## 検証で確認できていること

DevTools MCP（iPhone エミュレーション + iOS Safari UA）でスクリプト経由のイベント
dispatch では、以下のすべてのケースでビューアが開いた：

- `pointerdown` on img（pointerType: touch）→ `pointerup` on wrapper → ビューア開く
- `pointerdown` on img → `pointercancel` on wrapper → ビューア開く（フォールバック）
- 上記 + 直後に合成 `pointerdown` (pointerType: mouse) → ビューアは閉じない（350ms ガード）

つまり**コードのロジック上は正しく動くはず**だが、実機 Android では何かが違う。

## 仮説（未検証）

### A. 別の経路で `_onPointerDown` の早期 return が発火している

```js
if (e.target.closest('a')) return;
if (e.target.closest('.card-video-play')) return;
if (e.target.closest('.card-video-el')) return;
this._startTarget = e.target;
```

カード footer の `<a class="card-link">` は別位置だが、何か想定外の要素が `<a>` を
祖先に持っている可能性？要確認。

### B. `setPointerCapture` が Android Chrome で失敗している

例外が出るか、capture が確立されないまま `pointerup` が img に届き、bubbling は
するが `e.currentTarget` が想定と違う？

### C. `_startTarget` が pointerup 時点で stale になっている

途中で DOM が再描画されて `_startTarget.closest()` が null を返す可能性。
`_render()` が touch 中に呼ばれることがあるか？

### D. Long-press タイマー（500ms）が誤発火している

Android のタッチ判定で、長めのタップ（300ms 程度）でも `_dragging = false` に
されてしまっている？

### E. `pointermove` で `_curX` / `_curY` が 12px を超えている

ユーザは「タッチ精度の問題ではない」と言っているが、Android Chrome の touch jitter
は侮れない。閾値を上げるべきか？

### F. `touch-action: pan-x` と `touch-action: none` の競合

`.card-image-scroll` (touch-action: pan-x) が wrapper の touch-action: none を
オーバーライドして、Chrome がスクロール扱いし `pointercancel` を img に直接送る
（wrapper には届かない）？

### G. ビューアは開いているが CSS の問題で見えない

`z-index: 1000` だが、PWA の Service Worker が古い CSS を返している？
あるいはモバイル特有の stacking context で隠れている？

## ユーザ環境

- 端末: Android（機種不明 — 要確認）
- ブラウザ: Chrome（PWA インストール済みかは不明）
- ネットワーク: ローカル開発サーバ（`http-server -p 8888`）or デプロイ版？要確認

## デバッグ提案

1. **on-screen ログ表示**を追加してユーザに見てもらう。`_onPointerDown` /
   `_onPointerUp` / `_onPointerCancel` の発火タイミングと `e.target.tagName`、
   `_curX/_curY`、`_startTarget?.tagName` を画面に表示。
2. ユーザに **Chrome DevTools リモートデバッグ**（USB 接続 + `chrome://inspect`）を
   依頼。コンソールログとイベントを直接見るのが最速。
3. それが無理なら、**最低限の単一画像テストページ**を作ってもらい、最小再現を取る。

## コミット範囲

- `js/swipe.js`: openImageViewer 全体、_onPointerDown / _onPointerUp /
  _onPointerCancel の画像タップ判定追加、openedAt ガード
- `css/style.css`: .img-viewer / .img-viewer-img、画像 img への callout 抑制
