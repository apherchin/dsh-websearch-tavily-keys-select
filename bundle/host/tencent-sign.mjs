/**
 * 腾讯云 API 3.0 的 **TC3-HMAC-SHA256** 签名（纯函数，零 I/O）。
 *
 * 单独成文件的两个理由：
 * 1. 签名是最容易写错、也最难从"HTTP 400"里看出原因的一段 ⇒ 必须能离线、逐字段测；
 * 2. 元宝搜索（`wsa`）只是第一个用它的产品，将来接别的腾讯云服务直接复用。
 *
 * 规范出处（2026-10-22 核对）：腾讯云《签名方法 v3》`/document/api/1806/121816`。三条易错点：
 * - **参与签名的头部固定为 `content-type;host;x-tc-action`**（不是只有 content-type/host）；
 * - `Date` 必须由 `X-TC-Timestamp` 按 **UTC+0** 换算（东八区凌晨会差一天）；
 * - `Content-Type` 必须与实际发送的**逐字一致**，这里统一 `application/json; charset=utf-8`。
 */
import { createHash, createHmac } from 'node:crypto'

/** 签名算法名（Authorization 的第一个词）。 */
export const TC3_ALGORITHM = 'TC3-HMAC-SHA256'
/** 参与签名的头部（顺序即 SignedHeaders 的顺序，必须 ASCII 升序）。 */
export const SIGNED_HEADERS = 'content-type;host;x-tc-action'
/** 我们实际发送的 Content-Type（签名里用的是同一个常量，避免两处漂移）。 */
export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8'
/** 终止字符串。 */
const TC3_REQUEST = 'tc3_request'

/** 小写十六进制 SHA-256。 */
export function sha256Hex(text) {
	return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** HMAC-SHA256（`key` 可为 Buffer 或字符串），返回二进制 Buffer。 */
export function hmacSha256(key, text) {
	return createHmac('sha256', key).update(text, 'utf8').digest()
}

/**
 * 由 UNIX 秒时间戳取**UTC** 日期 `YYYY-MM-DD`。
 * @param timestampSeconds - 秒级时间戳。
 */
export function utcDateOf(timestampSeconds) {
	return new Date(timestampSeconds * 1000).toISOString().slice(0, 10)
}

/**
 * 拼接规范请求串（CanonicalRequest）。
 *
 * 形状（字段之间各一个 `\n`，CanonicalHeaders 自带末尾换行 ⇒ 中间那行是空行）：
 * ```
 * POST\n/\n\ncontent-type:…\nhost:…\nx-tc-action:searchpro\n\ncontent-type;host;x-tc-action\n<sha256(payload)>
 * ```
 */
export function buildCanonicalRequest({ method = 'POST', uri = '/', query = '', host, action, payload }) {
	const canonicalHeaders = `content-type:${JSON_CONTENT_TYPE}\nhost:${host}\nx-tc-action:${String(action).toLowerCase()}\n`
	return `${method}\n${uri}\n${query}\n${canonicalHeaders}\n${SIGNED_HEADERS}\n${sha256Hex(payload)}`
}

/**
 * 计算一次请求的签名与 Authorization 头。
 *
 * @param options.secretId - 腾讯云 SecretId（明文）。
 * @param options.secretKey - 腾讯云 SecretKey（机密）。
 * @param options.service - 产品名（域名前缀，元宝搜索 = `wsa`）。
 * @param options.host - 请求域名（如 `wsa.tencentcloudapi.com`）。
 * @param options.action - 接口名（如 `SearchPro`）。
 * @param options.payload - **实际发送的**请求体字符串（必须逐字节一致）。
 * @param options.timestamp - 秒级时间戳（注入用；缺省取当前时间）。
 * @returns 签名中间结果与可直接用的 `authorization` 头。
 */
export function buildTc3Authorization(options) {
	const { secretId, secretKey, service, host, action, payload } = options ?? {}
	for (const [name, value] of Object.entries({ secretId, secretKey, service, host, action })) {
		if (typeof value !== 'string' || value.length === 0) throw new TypeError(`buildTc3Authorization: ${name} must be a non-empty string`)
	}
	if (typeof payload !== 'string') throw new TypeError('buildTc3Authorization: payload must be a string')
	const timestamp = Number.isInteger(options.timestamp) ? options.timestamp : Math.floor(Date.now() / 1000)
	const date = utcDateOf(timestamp)
	const credentialScope = `${date}/${service}/${TC3_REQUEST}`
	const canonicalRequest = buildCanonicalRequest({ host, action, payload })
	const stringToSign = `${TC3_ALGORITHM}\n${timestamp}\n${credentialScope}\n${sha256Hex(canonicalRequest)}`
	const secretDate = hmacSha256(`TC3${secretKey}`, date)
	const secretService = hmacSha256(secretDate, service)
	const secretSigning = hmacSha256(secretService, TC3_REQUEST)
	const signature = createHmac('sha256', secretSigning).update(stringToSign, 'utf8').digest('hex')
	const authorization = `${TC3_ALGORITHM} Credential=${secretId}/${credentialScope}, SignedHeaders=${SIGNED_HEADERS}, Signature=${signature}`
	return { authorization, signature, timestamp, date, credentialScope, canonicalRequest, stringToSign }
}
