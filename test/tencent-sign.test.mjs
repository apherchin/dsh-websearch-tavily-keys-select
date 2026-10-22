import { test, summary, assert } from './harness.mjs'
import {
	TC3_ALGORITHM,
	SIGNED_HEADERS,
	JSON_CONTENT_TYPE,
	sha256Hex,
	hmacSha256,
	utcDateOf,
	buildCanonicalRequest,
	buildTc3Authorization,
} from '../bundle/host/tencent-sign.mjs'

console.log('-- tencent-sign: TC3-HMAC-SHA256 --')

/**
 * **独立实现**（WebCrypto 的 async API，与源实现的 `node:crypto` 同步 API 不同一条代码路径）。
 * 用它当"第二个证人"：两边算出的 Authorization 必须逐字相同。
 */
async function webcryptoAuthorization({ secretId, secretKey, service, host, action, payload, timestamp }) {
	const encoder = new TextEncoder()
	const digest = async (text) => Buffer.from(await crypto.subtle.digest('SHA-256', encoder.encode(text))).toString('hex')
	const hmac = async (keyBytes, text) => {
		const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
		return Buffer.from(await crypto.subtle.sign('HMAC', key, encoder.encode(text)))
	}
	const date = new Date(timestamp * 1000).toISOString().slice(0, 10)
	const canonicalHeaders = `content-type:${JSON_CONTENT_TYPE}\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`
	const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${SIGNED_HEADERS}\n${await digest(payload)}`
	const stringToSign = `${TC3_ALGORITHM}\n${timestamp}\n${date}/${service}/tc3_request\n${await digest(canonicalRequest)}`
	const secretDate = await hmac(encoder.encode(`TC3${secretKey}`), date)
	const secretService = await hmac(secretDate, service)
	const secretSigning = await hmac(secretService, 'tc3_request')
	const raw = await hmac(secretSigning, stringToSign)
	return `${TC3_ALGORITHM} Credential=${secretId}/${date}/${service}/tc3_request, SignedHeaders=${SIGNED_HEADERS}, Signature=${raw.toString('hex')}`
}

const FIXED = {
	secretId: 'AKIDtestSecretId0000000000000000',
	secretKey: 'test-secret-key-not-real',
	service: 'wsa',
	host: 'wsa.tencentcloudapi.com',
	action: 'SearchPro',
	payload: '{"Query":"今天北京的天气","Mode":2,"Cnt":10}',
	timestamp: 1793000000,
}

await test('sha256Hex / hmacSha256 是标准算法（对已知向量）', () => {
	assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
	// RFC 4231 test case 2（key="Jefe", data="what do ya want for nothing?"）
	assert.equal(hmacSha256('Jefe', 'what do ya want for nothing?').toString('hex'), '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843')
})

await test('utcDateOf 用 UTC 换算（东八区凌晨不能算成第二天）', () => {
	// 2019-02-26 00:44:25 +08:00 == 2019-02-25 16:44:25 UTC ⇒ 2019-02-25
	assert.equal(utcDateOf(1551113065), '2019-02-25')
	assert.equal(utcDateOf(1793000000), '2026-10-26')
})

await test('canonicalRequest 的形状（含 x-tc-action、空行、payload 哈希）', () => {
	const canonical = buildCanonicalRequest({ host: FIXED.host, action: FIXED.action, payload: FIXED.payload })
	const lines = canonical.split('\n')
	assert.equal(lines[0], 'POST')
	assert.equal(lines[1], '/')
	assert.equal(lines[2], '')
	assert.equal(lines[3], `content-type:${JSON_CONTENT_TYPE}`)
	assert.equal(lines[4], `host:${FIXED.host}`)
	assert.equal(lines[5], 'x-tc-action:searchpro')
	assert.equal(lines[6], '')
	assert.equal(lines[7], SIGNED_HEADERS)
	assert.equal(lines[8], sha256Hex(FIXED.payload))
	assert.equal(lines.length, 9)
})

await test('★与独立实现（WebCrypto）逐字一致 —— 三组不同 payload', async () => {
	const payloads = [FIXED.payload, '{}', JSON.stringify({ Query: 'a"b\\c\n中文🙂' })]
	for (const payload of payloads) {
		const ours = buildTc3Authorization({ ...FIXED, payload })
		const theirs = await webcryptoAuthorization({ ...FIXED, payload })
		assert.equal(ours.authorization, theirs, `payload=${payload}`)
	}
})

await test('Authorization 的固定格式：算法 / Credential / SignedHeaders / Signature', () => {
	const { authorization, date } = buildTc3Authorization(FIXED)
	assert.ok(authorization.startsWith('TC3-HMAC-SHA256 Credential='), authorization)
	assert.ok(authorization.includes(`/${date}/wsa/tc3_request, `), authorization)
	assert.ok(authorization.includes('SignedHeaders=content-type;host;x-tc-action, '), authorization)
	assert.match(authorization, /Signature=[0-9a-f]{64}$/u)
	assert.equal(date, '2026-10-26')
})

await test('★金标：固定输入 ⇒ 固定签名（算法被改动时这里会红）', () => {
	const { signature } = buildTc3Authorization(FIXED)
	assert.equal(signature, '1ebcfd508f127041a3eb1dd051b873ca036100389270173a03aaa2b62f06c840')
})

await test('任何一个字段变化都会改签名（不是把参数漏进哈希）', () => {
	const base = buildTc3Authorization(FIXED).signature
	const variants = [
		{ ...FIXED, payload: `${FIXED.payload} ` },
		{ ...FIXED, action: 'SearchPro2' },
		{ ...FIXED, service: 'wsa2' },
		{ ...FIXED, timestamp: FIXED.timestamp + 1 },
		{ ...FIXED, secretKey: `${FIXED.secretKey}x` },
	]
	for (const variant of variants) {
		assert.notEqual(buildTc3Authorization(variant).signature, base, JSON.stringify(Object.keys(variant)))
	}
	assert.equal(buildTc3Authorization(FIXED).signature, base, '同输入必须同输出')
})

await test('缺字段 / payload 不是字符串 ⇒ TypeError（别把 undefined 签进去）', () => {
	assert.throws(() => buildTc3Authorization({ ...FIXED, secretId: '' }), /secretId/u)
	assert.throws(() => buildTc3Authorization({ ...FIXED, secretKey: undefined }), /secretKey/u)
	assert.throws(() => buildTc3Authorization({ ...FIXED, payload: undefined }), /payload/u)
})

await test('缺省 timestamp 取当前秒（60 秒内）', () => {
	const before = Math.floor(Date.now() / 1000)
	const { timestamp } = buildTc3Authorization({ ...FIXED, timestamp: undefined })
	const after = Math.floor(Date.now() / 1000)
	assert.ok(timestamp >= before && timestamp <= after, String(timestamp))
})

summary('tencent-sign')
