/**
 * swipe-proxy — X (Twitter) API CORS プロキシ
 *
 * POST /proxy
 *   Body: { url: string, headers: Record<string, string> }
 *   Header: X-Proxy-Secret: <PROXY_SECRET>
 *
 * GET /media?url=<url>&secret=<PROXY_SECRET>
 *   video.twimg.com への Range 対応ストリーミング中継
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
	PROXY_SECRET: string
}

const app = new Hono<{ Bindings: Bindings }>()

// 許可するオリジン（GitHub Pages + ローカル開発）
const ALLOWED_ORIGINS = [
	'https://okayokayoka.github.io',
	'http://localhost:8888',
	'http://localhost',
]

// CORS: 許可オリジンのみ（* は使わない）
app.use('*', cors({
	origin: (origin) => ALLOWED_ORIGINS.includes(origin) ? origin : '',
	allowMethods: ['GET', 'POST', 'OPTIONS'],
	allowHeaders: ['Content-Type', 'X-Proxy-Secret'],
	exposeHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges', 'X-Upstream-Status'],
}))

// /proxy で転送を許可するヘッダの allowlist（open-relay 防止）
const ALLOWED_PROXY_HEADERS = new Set([
	'authorization',
	'cookie',
	'x-csrf-token',
	'x-twitter-auth-type',
	'x-twitter-active-user',
	'x-twitter-client-language',
	'user-agent',
	'accept',
	'accept-language',
	'referer',
	'origin',
])

/** シークレット検証。未設定（空）の場合は常に拒否 */
function checkSecret(provided: string | undefined, expected: string | undefined): boolean {
	if (!expected) return false
	return provided === expected
}

/** リクエストの Origin に基づいて許可オリジンを返す */
function getAllowedOrigin(origin: string | undefined): string {
	return (origin && ALLOWED_ORIGINS.includes(origin)) ? origin : ''
}

// ヘルスチェック
app.get('/', (c) => c.json({ status: 'ok', name: 'swipe-proxy' }))

// CORSプロキシ本体
app.post('/proxy', async (c) => {
	// PROXY_SECRET 必須（未設定は設定ミスとして 401）
	if (!checkSecret(c.req.header('X-Proxy-Secret'), c.env?.PROXY_SECRET)) {
		return c.json({ error: 'Unauthorized' }, 401)
	}

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

	// x.com / twitter.com 以外へのリクエストを拒否
	let parsedUrl: URL
	try {
		parsedUrl = new URL(url)
	} catch {
		return c.json({ error: 'Invalid url' }, 400)
	}

	const allowedHosts = ['x.com', 'twitter.com', 'api.twitter.com']
	const isAllowed = allowedHosts.some(
		(host) => parsedUrl.hostname === host || parsedUrl.hostname.endsWith('.' + host)
	)
	if (!isAllowed) {
		return c.json({ error: `Disallowed host: ${parsedUrl.hostname}` }, 403)
	}

	// allowlist でフィルタした安全なヘッダだけ転送
	const safeHeaders: Record<string, string> = {}
	for (const [key, value] of Object.entries(headers ?? {})) {
		if (ALLOWED_PROXY_HEADERS.has(key.toLowerCase())) {
			safeHeaders[key] = value
		}
	}

	let resp: Response
	try {
		resp = await fetch(url, { method: 'GET', headers: safeHeaders })
	} catch (e) {
		return c.json({ error: `Fetch failed: ${String(e)}` }, 502)
	}

	const text = await resp.text()

	return new Response(text, {
		status: resp.status,
		headers: {
			'Content-Type': resp.headers.get('Content-Type') ?? 'application/json',
			'X-Upstream-Status': String(resp.status),
		},
	})
})

// GET /media — 動画などのストリーミング中継
// video.twimg.com の MP4 は外部から直接読み込むと 403/CORS で失敗するため Worker で中継。
// Range ヘッダを中継してストリーミング再生に対応。
app.get('/media', async (c) => {
	// PROXY_SECRET 必須
	if (!checkSecret(c.req.query('secret'), c.env?.PROXY_SECRET)) {
		return c.json({ error: 'Unauthorized' }, 401)
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
	const isAllowed = parsedUrl.hostname === 'twimg.com' || parsedUrl.hostname.endsWith('.twimg.com')
	if (!isAllowed) {
		return c.json({ error: `Disallowed host: ${parsedUrl.hostname}` }, 403)
	}

	// Range ヘッダを中継（ストリーミング再生に必要）
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

	// 必要なレスポンスヘッダのみ転送
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

	// CORS: 許可オリジンのみ
	const corsOrigin = getAllowedOrigin(c.req.header('Origin'))
	if (corsOrigin) {
		respHeaders.set('Access-Control-Allow-Origin', corsOrigin)
		respHeaders.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')
	}

	return new Response(resp.body, {
		status: resp.status,
		headers: respHeaders,
	})
})

export default app
