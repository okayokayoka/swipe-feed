/**
 * swipe-proxy — X (Twitter) API CORS プロキシ
 *
 * POST /proxy
 *   Body: { url: string, headers: Record<string, string> }
 *   Header: X-Proxy-Secret: <PROXY_SECRET>
 *
 * X の GraphQL API はブラウザから直接呼べないため（CORS）、
 * このWorkerが中継役となりCORSヘッダを付けて返す。
 * x.com / twitter.com 以外へのリクエストは拒否する。
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
	PROXY_SECRET: string
}

const app = new Hono<{ Bindings: Bindings }>()

// すべてのルートにCORSヘッダを付与
app.use('*', cors({
	origin: '*',
	allowMethods: ['GET', 'POST', 'OPTIONS'],
	allowHeaders: ['Content-Type', 'X-Proxy-Secret'],
}))

// ヘルスチェック
app.get('/', (c) => c.json({ status: 'ok', name: 'swipe-proxy' }))

// CORSプロキシ本体
app.post('/proxy', async (c) => {
	// シークレットチェック（PROXY_SECRET が未設定の場合はスキップ）
	const secret = c.env?.PROXY_SECRET
	if (secret) {
		const provided = c.req.header('X-Proxy-Secret')
		if (provided !== secret) {
			return c.json({ error: 'Unauthorized' }, 401)
		}
	}

	// リクエストボディの検証
	let body: { url: string; headers: Record<string, string> }
	try {
		body = await c.req.json()
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400)
	}

	const { url, headers } = body
	if (!url || typeof url !== 'string') {
		return c.json({ error: 'Missing url' }, 400)
	}

	// x.com / twitter.com 以外へのリクエストを拒否（セキュリティ）
	let parsedUrl: URL
	try {
		parsedUrl = new URL(url)
	} catch {
		return c.json({ error: 'Invalid url' }, 400)
	}

	const allowed = ['x.com', 'twitter.com', 'api.twitter.com']
	const isAllowed = allowed.some(
		(host) => parsedUrl.hostname === host || parsedUrl.hostname.endsWith('.' + host)
	)
	if (!isAllowed) {
		return c.json({ error: `Disallowed host: ${parsedUrl.hostname}` }, 403)
	}

	// X API へリクエストを転送
	let resp: Response
	try {
		resp = await fetch(url, {
			method: 'GET',
			headers: headers ?? {},
		})
	} catch (e) {
		return c.json({ error: `Fetch failed: ${String(e)}` }, 502)
	}

	const text = await resp.text()

	return new Response(text, {
		status: resp.status,
		headers: {
			'Content-Type': resp.headers.get('Content-Type') ?? 'application/json',
			'Access-Control-Allow-Origin': '*',
			'X-Upstream-Status': String(resp.status),
		},
	})
})

// ────────────────────────────────────────
// GET /media — 動画など大容量メディアのストリーミング中継
// ────────────────────────────────────────
// video.twimg.com の MP4 は外部サイトから直接読み込むと 403/CORS で失敗するため
// Worker で中継する。Range ヘッダを中継してストリーミング再生に対応。
// PROXY_SECRET はクエリパラメータ `secret` で渡す（video.src にヘッダを付けられないため）。
app.get('/media', async (c) => {
	// シークレットチェック
	const secret = c.env?.PROXY_SECRET
	if (secret) {
		const provided = c.req.query('secret')
		if (provided !== secret) {
			return c.json({ error: 'Unauthorized' }, 401)
		}
	}

	const url = c.req.query('url')
	if (!url) return c.json({ error: 'Missing url' }, 400)

	let parsedUrl: URL
	try {
		parsedUrl = new URL(url)
	} catch {
		return c.json({ error: 'Invalid url' }, 400)
	}

	// twimg.com ドメインのみ許可
	const allowed = ['twimg.com']
	const isAllowed = allowed.some(
		(host) => parsedUrl.hostname === host || parsedUrl.hostname.endsWith('.' + host)
	)
	if (!isAllowed) {
		return c.json({ error: `Disallowed host: ${parsedUrl.hostname}` }, 403)
	}

	// Range ヘッダを中継
	const rangeHeader = c.req.header('Range')
	const fetchHeaders: Record<string, string> = {
		'Referer': 'https://x.com/',
		'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
	}
	if (rangeHeader) fetchHeaders['Range'] = rangeHeader

	let resp: Response
	try {
		resp = await fetch(url, { method: 'GET', headers: fetchHeaders })
	} catch (e) {
		return c.json({ error: `Fetch failed: ${String(e)}` }, 502)
	}

	// 動画レスポンスヘッダを中継
	const respHeaders = new Headers()
	const forwardHeaders = [
		'content-type',
		'content-length',
		'content-range',
		'accept-ranges',
		'cache-control',
		'etag',
		'last-modified',
	]
	for (const h of forwardHeaders) {
		const v = resp.headers.get(h)
		if (v) respHeaders.set(h, v)
	}
	respHeaders.set('Access-Control-Allow-Origin', '*')
	respHeaders.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')

	return new Response(resp.body, {
		status: resp.status,
		headers: respHeaders,
	})
})

export default app
