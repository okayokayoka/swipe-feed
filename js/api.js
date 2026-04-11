/**
 * api.js — X (Twitter) GraphQL API クライアント
 *
 * Cloudflare Worker（CORSプロキシ）経由で X のリストタイムラインを取得する。
 * 認証: auth_token (セッションCookie) を使ったOAuth2Session方式。
 */

// X Web クライアントに埋め込まれた固定Bearerトークン（公開情報）
const BEARER_TOKEN = 'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

// GraphQL クエリID（twitter-api-client constants より）
const LIST_TIMELINE_QUERY_ID = '2TemLyqrMpTeAmysdbnVqw';

// GraphQL feature フラグ（X API が要求する固定パラメータ）
const FEATURES = {
  rweb_lists_timeline_redesign_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  responsive_web_graphql_skip_user_profile_image_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: false,
  responsive_web_tweet_detail_side_effects_enabled: true,
  responsive_web_enhanced_timeline_enabled: false,
  responsive_web_graphql_enable_app_emoji_reactions: true,
  creator_subscriptions_tweet_preview_api_enabled: true,
  tweetypie_unmention_optimization_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: false,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: false,
  interactive_text_enabled: true,
  responsive_web_text_conversations_enabled: false,
  longform_notetweets_rich_text_read_enabled: false,
  responsive_web_enhance_cards_enabled: false,
};

/**
 * auth_token から ct0（CSRFトークン）を生成する。
 * X は ct0 として 32桁の16進文字列を使う。
 * 既に ct0 cookie がある場合はそれを使うべきだが、
 * ブラウザ外なので auth_token をハッシュして生成する簡易実装を使う。
 */
async function deriveCt0(authToken) {
  const msgBuffer = new TextEncoder().encode(authToken + 'csrf');
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * CORS プロキシ経由で X API を呼び出す。
 * @param {string} url - 転送先URL
 * @param {Record<string, string>} headers - 転送するヘッダ
 * @param {string} workerUrl - Cloudflare Worker の URL
 * @param {string} proxySecret - プロキシシークレット（設定している場合）
 */
async function callViaProxy(url, headers, workerUrl, proxySecret) {
  const reqHeaders = { 'Content-Type': 'application/json' };
  if (proxySecret) reqHeaders['X-Proxy-Secret'] = proxySecret;

  const resp = await fetch(workerUrl + '/proxy', {
    method: 'POST',
    headers: reqHeaders,
    body: JSON.stringify({ url, headers }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Proxy error ${resp.status}: ${errText}`);
  }
  return resp.json();
}

/**
 * リストタイムラインを取得する。
 * @param {object} params
 * @param {string} params.listId - X リスト ID
 * @param {string} params.authToken - auth_token cookie の値
 * @param {string} params.workerUrl - Cloudflare Worker URL
 * @param {string} [params.proxySecret] - プロキシシークレット
 * @param {string} [params.cursor] - ページネーション用カーソル
 * @param {number} [params.count=40] - 取得件数
 * @returns {{ tweets: Tweet[], nextCursor: string|null }}
 */
export async function fetchListTimeline({ listId, authToken, workerUrl, proxySecret, cursor, count = 40 }) {
  const ct0 = await deriveCt0(authToken);

  const variables = {
    listId,
    count,
    ...(cursor ? { cursor } : {}),
  };

  const url =
    `https://x.com/i/api/graphql/${LIST_TIMELINE_QUERY_ID}/ListLatestTweetsTimeline` +
    `?variables=${encodeURIComponent(JSON.stringify(variables))}` +
    `&features=${encodeURIComponent(JSON.stringify(FEATURES))}`;

  const headers = {
    'Authorization': `Bearer ${BEARER_TOKEN}`,
    'Cookie': `auth_token=${authToken}; ct0=${ct0}`,
    'X-Csrf-Token': ct0,
    'X-Twitter-Auth-Type': 'OAuth2Session',
    'X-Twitter-Active-User': 'yes',
    'X-Twitter-Client-Language': 'ja',
    'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'ja,en-US;q=0.9',
    'Referer': 'https://x.com/',
    'Origin': 'https://x.com',
  };

  const data = await callViaProxy(url, headers, workerUrl, proxySecret);
  return extractTweets(data);
}

/**
 * GraphQL レスポンスからツイートを抽出する。
 * @param {object} response - X GraphQL API レスポンス
 * @returns {{ tweets: Tweet[], nextCursor: string|null }}
 */
function extractTweets(response) {
  const tweets = [];
  let nextCursor = null;

  let instructions;
  try {
    instructions = response.data.list.tweets_timeline.timeline.instructions;
  } catch {
    console.error('Unexpected response structure:', JSON.stringify(response).slice(0, 500));
    return { tweets, nextCursor };
  }

  for (const instruction of instructions) {
    if (instruction.type !== 'TimelineAddEntries') continue;

    for (const entry of instruction.entries) {
      // カーソルエントリ（次ページ）
      if (entry.content.entryType === 'TimelineTimelineCursor' &&
          entry.content.cursorType === 'Bottom') {
        nextCursor = entry.content.value;
        continue;
      }

      // ツイートエントリ以外はスキップ
      if (entry.content.entryType !== 'TimelineTweet') continue;

      const result = entry.content?.itemContent?.tweet_results?.result;
      if (!result || result.__typename !== 'Tweet') continue;

      const userLegacy = result.core?.user_results?.result?.legacy;
      const legacy = result.legacy;
      if (!userLegacy || !legacy) continue;

      // リプライはスキップ（@で始まり、RTではない）
      const text = legacy.full_text || '';
      if (text.startsWith('@') && !text.startsWith('RT @')) continue;

      // 画像を抽出（photoタイプのみ）
      const rawMedia = legacy.entities?.media || legacy.extended_entities?.media || [];
      const images = rawMedia
        .filter(m => m.type === 'photo')
        .map(m => m.media_url_https || m.media_url)
        .filter(Boolean)
        .slice(0, 4);

      // 引用ツイートを抽出
      const quotedResult = result.quoted_status_result?.result;
      let quotedTweet = null;
      if (quotedResult?.legacy) {
        quotedTweet = {
          text: quotedResult.legacy.full_text || '',
          author: quotedResult.core?.user_results?.result?.legacy?.screen_name || '',
        };
      }

      // RT本文から「RT @handle: 」プレフィックスを除去して元ツイートのテキストを取得
      const displayText = text.replace(/^RT @\w+: /, '');

      tweets.push({
        id: result.rest_id,
        text: displayText,
        rawText: text,
        isRetweet: text.startsWith('RT @'),
        author: {
          handle: userLegacy.screen_name,
          name: userLegacy.name,
          avatar: userLegacy.profile_image_url_https,
        },
        createdAt: legacy.created_at,
        createdAtMs: new Date(legacy.created_at).getTime(),
        favoriteCount: legacy.favorite_count || 0,
        retweetCount: legacy.retweet_count || 0,
        replyCount: legacy.reply_count || 0,
        link: `https://x.com/${userLegacy.screen_name}/status/${result.rest_id}`,
        images,
        quotedTweet,
      });
    }
  }

  return { tweets, nextCursor };
}
