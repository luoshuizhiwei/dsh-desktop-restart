/**
 * dsh-desktop-restart — 顺手清理「别人漏下的」改动快照临时目录。
 *
 * 背景：DSH 内置的「改动快照」（`@deepseek-ai/dsh-workspace-changes`）每开一个会话
 * 就往系统 Temp 里写一个 `dsh-workspace-changes-*` 目录，会话关闭或应用**正常退出**
 * 时删除。应用被硬杀（任务管理器结束 host、崩溃、断电）时没人删，于是越积越多 ——
 * 2026-10-09 的 C 盘体检在 Temp 里清出 25 个这样的目录、共 10.9 GB。
 *
 * 本模块只做一件事：**只删「孤儿」**。判定规则见 {@link orphanSnapshots}，四条同时
 * 成立才动手：
 *
 * 1. 名字是快照前缀（不碰 Temp 里任何别的东西）；
 * 2. 是个目录；
 * 3. 创建时间早于本次宿主启动 —— 本次进程里的会话目录都是启动之后才建的；
 * 4. 自本次宿主启动以来没被写过 —— 还有人在往里写就说明它不孤单；
 * 5. 而且已经躺够 {@link MIN_ORPHAN_AGE_MS} 那么久。
 *
 * 第 3、4 条是为了不碰活动会话：快照目录是懒建的，进程活着的时候新建的一定晚于
 * 启动时刻。第 5 条是给「同时开着第二个 DSH 实例（比如终端里的 `dsh web`）」留的
 * 余量。
 *
 * 已知边界：第二个实例里那个会话如果**完全空闲**超过 {@link MIN_ORPHAN_AGE_MS}，
 * 它的目录会被误判成孤儿。代价是那个实例该会话的改动对比卡片失效（目录里只是快照
 * 副本，不动任何用户数据），重启那个实例即可恢复。要彻底避免只能等上游修。
 *
 * @module dsh-desktop-restart/sweep
 */

import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** DSH 内置改动快照在系统 Temp 里的目录前缀。 */
export const SNAPSHOT_PREFIX = 'dsh-workspace-changes-'

/**
 * 孤儿快照的最小年龄：比这更年轻的目录一律不动。
 *
 * 取 24 小时是有意的保守值 —— 真正常见的孤儿来自几天前的崩溃/硬杀，而
 * 「另一个实例里闲置的活会话」也基本不会连续 24 小时一次都不写。
 */
export const MIN_ORPHAN_AGE_MS = 24 * 60 * 60 * 1000

/**
 * 从目录项里挑出可以安全删除的孤儿快照目录（纯函数，单测直接打）。
 *
 * @param {{ name: string, isDirectory?: () => boolean, createdAtMs: number, modifiedAtMs: number }[]} entries
 *   目录项：`isDirectory` 缺省时按目录处理（调用方从 `Dirent` 取值时给的是函数）。
 * @param {number} startedAtMs - 本次宿主的启动时刻（毫秒时间戳）。
 * @param {{ now?: number, minAgeMs?: number }} [options] - `now` 便于测试；`minAgeMs` 覆盖最小年龄。
 * @returns {string[]} 可以删除的目录名。
 */
export function orphanSnapshots(entries, startedAtMs, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const minAgeMs = Number.isFinite(options.minAgeMs) ? options.minAgeMs : MIN_ORPHAN_AGE_MS
  if (!Number.isFinite(startedAtMs)) return []
  const picked = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (typeof entry?.name !== 'string' || !entry.name.startsWith(SNAPSHOT_PREFIX)) continue
    if (typeof entry.isDirectory === 'function' && entry.isDirectory() === false) continue
    const created = Number(entry.createdAtMs)
    const modified = Number(entry.modifiedAtMs)
    if (!Number.isFinite(created) || !Number.isFinite(modified)) continue
    // 本次启动之后才建、或启动之后被写过：可能是活动会话正在用的目录。
    if (created >= startedAtMs) continue
    if (modified >= startedAtMs) continue
    if (now - created < minAgeMs) continue
    picked.push(entry.name)
  }
  return picked
}

/**
 * 统计一个目录树的大小（尽力而为：数不出来就当 0，绝不影响删除本身）。
 * @param {string} dir - 目录。
 * @returns {Promise<{ bytes: number, files: number }>} 大小与文件数。
 */
async function treeSize(dir) {
  let bytes = 0
  let files = 0
  try {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile() !== true) continue
      files += 1
      try {
        bytes += (await stat(join(entry.parentPath ?? dir, entry.name))).size
      } catch {
        /* 与删除/别处清理竞态：跳过这一个 */
      }
    }
  } catch {
    return { bytes: 0, files: 0 }
  }
  return { bytes, files }
}

/**
 * 跑一次清理：扫系统 Temp，把判定为孤儿的快照目录删掉。
 *
 * 永远不抛：任何一步失败都只是少删一个目录并记进 `failed`，绝不能因为清理
 * 出问题而影响宿主本身。
 *
 * @param {{ tempRoot?: string, startedAtMs?: number, minAgeMs?: number, now?: number, log?: (line: string) => void }} [options]
 *   清理参数；`log` 收到的每一行都会进插件日志。
 * @returns {Promise<{ scanned: number, removed: string[], failed: { name: string, error: string }[], bytes: number, files: number }>} 结果。
 */
export async function sweepOrphanSnapshots(options = {}) {
  const tempRoot = typeof options.tempRoot === 'string' ? options.tempRoot : ''
  const startedAtMs = Number(options.startedAtMs)
  const log = typeof options.log === 'function' ? options.log : () => {}
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const result = { scanned: 0, removed: [], failed: [], bytes: 0, files: 0 }
  if (tempRoot === '' || !Number.isFinite(startedAtMs)) return result

  let dirents
  try {
    dirents = await readdir(tempRoot, { withFileTypes: true })
  } catch {
    return result
  }

  const candidates = []
  for (const dirent of dirents) {
    if (!dirent.name.startsWith(SNAPSHOT_PREFIX)) continue
    result.scanned += 1
    let info
    try {
      info = await stat(join(tempRoot, dirent.name))
    } catch {
      continue
    }
    // Windows 的 NTFS 有创建时间；拿不到就退回状态变更时间（比 mtime 稳）。
    const created = Number.isFinite(info.birthtimeMs) && info.birthtimeMs > 0 ? info.birthtimeMs : info.ctimeMs
    candidates.push({
      name: dirent.name,
      isDirectory: () => info.isDirectory(),
      createdAtMs: created,
      modifiedAtMs: info.mtimeMs,
    })
  }

  const doomed = orphanSnapshots(candidates, startedAtMs, { now, minAgeMs: options.minAgeMs })
  for (const name of doomed) {
    const target = join(tempRoot, name)
    const size = await treeSize(target)
    try {
      await rm(target, { recursive: true, force: true })
      result.removed.push(name)
      result.bytes += size.bytes
      result.files += size.files
      log(`removed orphan snapshot ${name} (${String(size.files)} file(s), ${(size.bytes / 1048576).toFixed(1)} MB)`)
    } catch (error) {
      result.failed.push({ name, error: String((error && error.code) || (error && error.message) || error) })
      log(`could not remove orphan snapshot ${name}: ${String((error && error.message) || error)}`)
    }
  }
  return result
}
