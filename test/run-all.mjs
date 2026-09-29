/**
 * 进程内汇总跑全部 `*.test.mjs`。
 *
 * ⚠️ 刻意**不 spawn**（沙箱禁命名管道 ⇒ 捕获子进程输出会 EPERM）；每个测试文件自己在
 * 末尾调 `summary()`，有失败就把 `process.exitCode` 置 1，所以这里只需顺序 import。
 */
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const files = readdirSync(here).filter((name) => name.endsWith('.test.mjs')).sort()
for (const file of files) {
	console.log(`\n=== ${file} ===`)
	await import(pathToFileURL(join(here, file)).href)
}
console.log(`\n共 ${files.length} 个测试文件跑完；本进程退出码 = ${process.exitCode ?? 0}${process.exitCode === undefined ? '（全绿）' : '（有失败，见上面的 FAIL）'}`)
