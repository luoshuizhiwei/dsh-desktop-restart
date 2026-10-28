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
 * 2. 是个目录且整棵树无链接、可完整遍历；
 * 3. 创建时间早于本次宿主启动；
 * 4. 整棵目录树自本次宿主启动以来都没有文件或目录更新；
 * 5. 已超过 {@link MIN_ORPHAN_AGE_MS} 且调用方证明没有其他 DSH host。
 *
 * 时间判据不能证明另一个 DSH 实例已经退出。自动删除还要求调用方传入
 * `ownerCheck: { known: true, activeHosts: [] }`，表明全局 DSH host 查询成功且没有
 * 其他活动宿主。缺少证明时只返回预览，不删除。
 *
 * 仍需上游提供快照 owner/lease 才能严格证明并发启动窗口中没有活跃写入者。
 *
 * @module dsh-desktop-restart/sweep
 */

import { lstat, readdir, rm, stat } from 'node:fs/promises'
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
 * 从目录项里挑出满足年龄与递归写入时间条件的快照（纯函数）。
 * 这里只选时间候选；实例 owner 证明由 sweepOrphanSnapshots 另行要求。
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
    const modified = Number(entry.latestModifiedAtMs ?? entry.modifiedAtMs)
    if (!Number.isFinite(created) || !Number.isFinite(modified)) continue
    // 本次启动之后才建、或启动之后被写过：可能是活动会话正在用的目录。
    if (created >= startedAtMs) continue
    if (modified >= startedAtMs) continue
    if (now - created < minAgeMs) continue
    picked.push(entry.name)
  }
  return picked
}

/** Inspect without following symlinks, junctions, or other reparse points. */
async function inspectTree(dir, shouldStop) {
  let bytes = 0
  let files = 0
  let latestModifiedAtMs = 0
  const pending = [dir]
  try {
    while (pending.length > 0) {
      if (shouldStop()) return {safe:false,cancelled:true}
      const current = pending.pop()
      const info = await lstat(current)
      if (shouldStop()) return {safe:false,cancelled:true}
      if (info.isSymbolicLink()) return { safe: false, reason: 'link-in-tree' }
      latestModifiedAtMs = Math.max(latestModifiedAtMs, info.mtimeMs)
      if (info.isFile()) {
        files += 1
        bytes += info.size
        continue
      }
      if (!info.isDirectory()) return { safe: false, reason: 'unsupported-entry' }
      const children = await readdir(current, { withFileTypes: true })
      for (const child of children) {
        if (shouldStop()) return {safe:false,cancelled:true}
        if (child.isSymbolicLink()) return { safe: false, reason: 'link-in-tree' }
        pending.push(join(current, child.name))
      }
    }
  } catch {
    return { safe: false, reason: 'tree-unreadable' }
  }
  return { safe: true, bytes, files, latestModifiedAtMs }
}

/**
 * 扫系统 Temp，返回候选预览；只有 ownerCheck 证明无其他 DSH host 才允许删除。
 *
 * 候选时间和目录树都可读仍不能证明没有其他实例在用。缺少 ownerCheck 时只预览。
 *
 * @param {{ tempRoot?: string, startedAtMs?: number, minAgeMs?: number, now?: number, log?: (line: string) => void, statOf?: (target: string) => { isDirectory: () => boolean, birthtimeMs?: number, ctimeMs?: number, mtimeMs?: number }, ownerCheck?: { known: boolean, activeHosts: unknown[] } }} [options]
 *   清理参数；`log` 收到的每一行都会进插件日志；`statOf` 是测试专用的
 *   时间戳来源注入（生产路径不传，用 node:fs 的 stat）—— Linux 上
 *   `birthtime` 常不可用，测试需要固定时间戳而不是赌文件系统语义。
 * @returns {Promise<{ scanned: number, candidates: { name: string, bytes: number, files: number }[], preview: { bytes: number, files: number }, skipped: { name: string, reason: string }[], skipReason: 'owner-unknown' | 'active-hosts' | null, removed: string[], failed: { name: string, error: string }[], bytes: number, files: number }>} 结果。
 */
export async function sweepOrphanSnapshots(options = {}) {
  const tempRoot = typeof options.tempRoot === 'string' ? options.tempRoot : ''
  const startedAtMs = Number(options.startedAtMs)
  const log = typeof options.log === 'function' ? options.log : () => {}
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const shouldStop = typeof options.shouldStop === 'function' ? options.shouldStop : () => false
  const statOf = typeof options.statOf === 'function' ? options.statOf : stat
  const result = {
    scanned: 0,
    candidates: [],
    preview: { bytes: 0, files: 0 },
    skipped: [],
    skipReason: null,
    removed: [],
    failed: [],
    bytes: 0,
    files: 0,
    // 2026-10-21（DR-OPT-02 第 5 项）：扫描失败必须能说出来，不能长得像「成功扫到 0 项」。
    error: null,
    partial: false,
    /** 早筛省下的递归次数（便宜筛选挡住的目录） */
    prefiltered: 0,
  }
  if (tempRoot === '' || !Number.isFinite(startedAtMs)) return result

  let dirents
  try {
    dirents = await readdir(tempRoot, { withFileTypes: true })
  } catch (error) {
    // 权限拒绝、路径消失等：如实报错，绝不返回「扫描了 0 项」的成功形状。
    const code = typeof error?.code === 'string' ? error.code : 'temp-unreadable'
    result.error = { code, message: 'temp directory could not be read' }
    return result
  }

  const candidates = []
  const unsafe = []
  for (const dirent of dirents) {
    if (shouldStop()) {result.partial=true;break}
    if (!dirent.name.startsWith(SNAPSHOT_PREFIX)) continue
    result.scanned += 1
    if (dirent.isSymbolicLink()) {
      unsafe.push(dirent.name)
      continue
    }
    let info
    try {
      info = await statOf(join(tempRoot, dirent.name))
    } catch {
      unsafe.push(dirent.name)
      continue
    }
    const target = join(tempRoot, dirent.name)
    // 便宜筛选（先做，别先递归）：类型、创建时间、最小年龄、根目录新写入。
    // 必然不可能成为候选的目录不该付递归的代价。
    if (typeof info.isDirectory === 'function' && info.isDirectory() === false) {
      unsafe.push(dirent.name)
      continue
    }
    const createdEarly = Number.isFinite(info.birthtimeMs) && info.birthtimeMs > 0 ? info.birthtimeMs : info.ctimeMs
    const tooYoung = Number.isFinite(createdEarly) && now - createdEarly < (Number.isFinite(options.minAgeMs) ? options.minAgeMs : MIN_ORPHAN_AGE_MS)
    if (Number.isFinite(createdEarly) && (createdEarly >= startedAtMs || tooYoung)) {
      // 本次启动之后才建、或还没躺够最小年龄：直接排除，不递归。
      result.prefiltered += 1
      unsafe.push(dirent.name)
      continue
    }
    if (Number.isFinite(info.mtimeMs) && info.mtimeMs >= startedAtMs) {
      // 启动之后根目录还被写过：可能是活动会话，同样不付出递归代价。
      result.prefiltered += 1
      unsafe.push(dirent.name)
      continue
    }
    if (shouldStop()) {
      // 取消：给出部分结果，并标明它不是完整扫描。
      result.partial = true
      break
    }
    const tree = await inspectTree(target, shouldStop)
    if (tree.cancelled) {result.partial=true;break}
    if (!tree.safe) {
      unsafe.push(dirent.name)
      continue
    }
    // Windows 的 NTFS 有创建时间；拿不到就退回状态变更时间（比 mtime 稳）。
    const created = Number.isFinite(info.birthtimeMs) && info.birthtimeMs > 0 ? info.birthtimeMs : info.ctimeMs
    candidates.push({
      name: dirent.name,
      // 箭头包裹而不是裸解引用：Stats.isDirectory 依赖 this（_checkModeProperty），
      // 裸函数调用会 TypeError（2026-10-20 本地实测）。
      isDirectory: typeof info.isDirectory === 'function' ? () => info.isDirectory() : () => true,
      createdAtMs: created,
      modifiedAtMs: info.mtimeMs,
      latestModifiedAtMs: Math.max(Number(info.mtimeMs) || 0, tree.latestModifiedAtMs),
      bytes: tree.bytes,
      files: tree.files,
    })
  }

  const doomed = orphanSnapshots(candidates, startedAtMs, { now, minAgeMs: options.minAgeMs })
  const byName = new Map(candidates.map((entry) => [entry.name, entry]))
  result.candidates = doomed.map((name) => ({ name, bytes: byName.get(name).bytes, files: byName.get(name).files }))
  result.preview = result.candidates.reduce((preview, entry) => ({
    bytes: preview.bytes + entry.bytes,
    files: preview.files + entry.files,
  }), { bytes: 0, files: 0 })
  const ownerCheck = options.ownerCheck
  const deleteAuthorized = ownerCheck?.known === true && Array.isArray(ownerCheck.activeHosts) && ownerCheck.activeHosts.length === 0
  result.skipped.push(...unsafe.map((name) => ({ name, reason: 'tree-unreadable-or-linked' })))
  if (!deleteAuthorized) {
    const reason = ownerCheck?.known === true ? 'active-hosts' : 'owner-unknown'
    result.skipped.push(...doomed.map((name) => ({ name, reason })))
    result.skipReason = reason
    return result
  }
  for (const name of doomed) {
    if (shouldStop()) {result.partial=true;break}
    const target = join(tempRoot, name)
    try {
      await rm(target, { recursive: true, force: true })
      result.removed.push(name)
      const entry = byName.get(name)
      result.bytes += entry.bytes
      result.files += entry.files
      log(`removed orphan snapshot ${name} (${String(entry.files)} file(s), ${(entry.bytes / 1048576).toFixed(1)} MB)`)
    } catch (error) {
      result.failed.push({ name, error: String((error && error.code) || (error && error.message) || error) })
      log(`could not remove orphan snapshot ${name}: ${String((error && error.message) || error)}`)
    }
  }
  return result
}
