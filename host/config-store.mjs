/**
 * 配置文档的读写层：路径解析、损坏降级、原子写。
 *
 * 所有 I/O 都收敛在这里，理由有二：
 * 1. 纯逻辑（`core.mjs`）才能离线测；
 * 2. **搜索链路每次搜索都调 `readConfigDocument`**，所以它绝不能抛 ——
 *    它抛错就等于 web_search 挂掉。任何异常都退成默认文档并把原因放进 `error`。
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MAX_DOCUMENT_BYTES, defaultDocument, parseDocumentText, serializeDocument } from './core.mjs'

/** 配置文档路径。 */
export function configDocumentPath(home) {
	return join(home, 'web-search-chain.json')
}

/**
 * 读配置文档。
 * @param path - 文档路径。
 * @returns `{doc, error}`；error 非空表示「按默认值工作」，doc 恒可用。
 */
export function readConfigDocument(path) {
	let size
	try {
		size = statSync(path).size
	} catch (error) {
		if (error?.code === 'ENOENT') return { doc: defaultDocument(), error: undefined }
		return { doc: defaultDocument(), error: `配置文件不可读：${String(error)}` }
	}
	if (size > MAX_DOCUMENT_BYTES) {
		return { doc: defaultDocument(), error: `配置文件超过 ${MAX_DOCUMENT_BYTES} 字节，已按默认值工作` }
	}
	let text
	try {
		text = readFileSync(path, 'utf8')
	} catch (error) {
		return { doc: defaultDocument(), error: `配置文件不可读：${String(error)}` }
	}
	const parsed = parseDocumentText(text)
	return {
		doc: parsed.doc,
		error: parsed.error === undefined ? undefined : `配置文件损坏（${parsed.error}），已按默认值工作`,
	}
}

/** 原子写：先写 `<path>.tmp` 再 rename 覆盖（不做原地截断）。 */
export function writeConfigDocument(path, doc) {
	const text = serializeDocument(doc)
	const temporary = `${path}.tmp`
	mkdirSync(dirname(path), { recursive: true })
	writeFileSync(temporary, text, 'utf8')
	renameSync(temporary, path)
}
