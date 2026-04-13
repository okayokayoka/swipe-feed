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
export async function fetchListTimeline({ listId, authToken, ct0, workerUrl, proxySecret, cursor, count = 40 }) {

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
  const result = extractTweets(data);

  // 動画URLは video.twimg.com が外部アクセスに403を返すため Worker 経由に書き換え
  for (const t of result.tweets) {
    if (!t.media) continue;
    for (const m of t.media) {
      if (m.type === 'video' || m.type === 'animated_gif') {
        const params = new URLSearchParams({ url: m.url });
        if (proxySecret) params.set('secret', proxySecret);
        m.url = `${workerUrl}/media?${params.toString()}`;
      }
    }
  }

  return result;
}

/**
 * video_info.variants から適切な MP4 variant を選ぶ。
 * bitrate 降順で並べ2番目（2番目に高品質）を採用。
 * 最高品質をスキップする理由は帯域節約（react-tweet と同じ戦略）。
 */
function pickMp4Variant(variants = []) {
  const mp4s = variants
    .filter(v => v.content_type === 'video/mp4')
    .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
  return mp4s.length > 1 ? mp4s[1] : mp4s[0];
}

/**
 * GraphQL レスポンスからツイートを抽出する。
 * @param {object} response - X GraphQL API レスポンス
 * @returns {{ tweets: Tweet[], nextCursor: string|null }}
 */
function extractTweets(response) {
  const tweets = [];
  let nextCursor = null;

  // X API エラーレスポンスを検出
  if (response.errors?.length > 0) {
    throw new Error(`X API: ${response.errors[0].message}`);
  }

  let instructions;
  try {
    instructions = response.data.list.tweets_timeline.timeline.instructions;
  } catch {
    const preview = JSON.stringify(response).slice(0, 300);
    console.error('Unexpected response structure:', preview);
    throw new Error('X API応答が不正: ' + preview);
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
      // entryType は TimelineTimelineItem、ツイート判定は itemContent.__typename
      if (entry.content.entryType !== 'TimelineTimelineItem') continue;
      if (entry.content.itemContent?.__typename !== 'TimelineTweet') continue;

      const result = entry.content?.itemContent?.tweet_results?.result;
      if (!result || result.__typename !== 'Tweet') continue;

      const userLegacy = result.core?.user_results?.result?.legacy;
      const legacy = result.legacy;
      if (!userLegacy || !legacy) continue;

      // リプライはスキップ（@で始まり、RTではない）
      const text = legacy.full_text || '';
      if (text.startsWith('@') && !text.startsWith('RT @')) continue;

      const isRetweet = text.startsWith('RT @');

      // RTの場合: 元ツイートの result / userLegacy / legacy に差し替える
      // retweeted_status_result に元ツイートのフルデータが入っている
      let srcResult    = result;
      let srcUserLeg   = userLegacy;
      let srcLegacy    = legacy;
      let retweetedBy  = null;

      if (isRetweet) {
        const rtResult = result.retweeted_status_result?.result;
        const rtUser   = rtResult?.core?.user_results?.result?.legacy;
        const rtLegacy = rtResult?.legacy;
        if (rtResult && rtUser && rtLegacy) {
          retweetedBy = userLegacy.screen_name; // RTしたユーザー名を保持
          srcResult   = rtResult;
          srcUserLeg  = rtUser;
          srcLegacy   = rtLegacy;
        }
      }

      // メディアを抽出（元ツイートの extended_entities を使う）
      const rawMedia = srcLegacy.extended_entities?.media || srcLegacy.entities?.media || [];
      const media = rawMedia
        .map(m => {
          const poster = m.media_url_https || m.media_url;
          if (m.type === 'photo') {
            return { type: 'photo', url: poster };
          }
          if (m.type === 'video' || m.type === 'animated_gif') {
            const variant = pickMp4Variant(m.video_info?.variants);
            if (!variant) return null;
            return {
              type: m.type,
              url: variant.url,
              poster,
              aspectRatio: m.video_info?.aspect_ratio ?? null,
            };
          }
          return null;
        })
        .filter(Boolean)
        .slice(0, 4);

      // 引用ツイートを抽出
      const quotedResult = srcResult.quoted_status_result?.result;
      let quotedTweet = null;
      if (quotedResult?.legacy) {
        quotedTweet = {
          text: quotedResult.legacy.full_text || '',
          author: quotedResult.core?.user_results?.result?.legacy?.screen_name || '',
        };
      }

      tweets.push({
        id: result.rest_id,           // IDはRT自体（既読管理に使用）
        text: srcLegacy.full_text || '',
        rawText: text,
        isRetweet,
        retweetedBy,                  // RTしたユーザー（カード表示用）
        author: {
          handle: srcUserLeg.screen_name,
          name: srcUserLeg.name,
          avatar: srcUserLeg.profile_image_url_https,
        },
        createdAt: srcLegacy.created_at,
        createdAtMs: new Date(srcLegacy.created_at).getTime(),
        favoriteCount: srcLegacy.favorite_count || 0,
        retweetCount: srcLegacy.retweet_count || 0,
        replyCount: srcLegacy.reply_count || 0,
        link: `https://x.com/${srcUserLeg.screen_name}/status/${srcResult.rest_id}`,
        media,
        quotedTweet,
      });
    }
  }

  return { tweets, nextCursor };
}
