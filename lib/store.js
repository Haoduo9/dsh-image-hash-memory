/**
 * store.js — 本地 SQLite 视觉记忆库。
 *
 * 用 Node 内置的 node:sqlite（Node >= 22.5），零原生编译依赖。
 * 表结构与 Python 版 image_memory.db 基本对齐，方便以后迁移数据。
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { hammingDistance, passesCompositeGate, compareHashes } from './hasher.js'

/** 默认库位置：跟 millions of 其他 DSH 状态放一起 */
export function defaultDbPath() {
  return join(homedir(), '.dsh', 'state', 'image-hash-memory.db')
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS images (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  attachment_id TEXT UNIQUE,
  dhash         TEXT NOT NULL,
  ahash         TEXT,
  phash         TEXT,
  width         INTEGER,
  height        INTEGER,
  file_size     INTEGER,
  file_path     TEXT,
  session_id    TEXT,
  platform      TEXT,
  user_text     TEXT,
  summary       TEXT,
  hit_count     INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_images_dhash ON images(dhash);
CREATE INDEX IF NOT EXISTS idx_images_session ON images(session_id);
CREATE INDEX IF NOT EXISTS idx_images_attachment ON images(attachment_id);
`

/** 一键查询时对候选集的大小上限，防止库大了以后每轮全表算距离 */
const MAX_CANDIDATES = 20000

export class ImageMemoryStore {
  /**
   * @param {string} [dbPath]
   */
  constructor(dbPath = defaultDbPath()) {
    this.path = dbPath === ':memory:' ? dbPath : dbPath
    if (this.path !== ':memory:') mkdirSync(dirname(this.path), { recursive: true })
    this.db = new DatabaseSync(this.path)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec(SCHEMA)
    this._insert = this.db.prepare(`
      INSERT INTO images
        (attachment_id, dhash, ahash, phash, width, height, file_size,
         file_path, session_id, platform, user_text, summary, first_seen_at, last_seen_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `)
    this._byAttachment = this.db.prepare('SELECT * FROM images WHERE attachment_id = ?')
    this._allHashes = this.db.prepare(
      'SELECT id, attachment_id, dhash, phash, phash IS NOT NULL AS has_phash FROM images LIMIT ?',
    )
  }

  close() {
    try {
      this.db.close()
    } catch {
      /* 已关闭 */
    }
  }

  /** @returns {number} */
  count() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM images').get().n
  }

  /**
   * 按 attachment_id 精确取一条（同一张图重复上传时最快）。
   * @param {string} attachmentId
   */
  getByAttachment(attachmentId) {
    return this._byAttachment.get(attachmentId) ?? null
  }

  /**
   * 库内相似检索。先用 SQLite 归集候选哈希，再在 JS 里算汉明距离。
   *
   * @param {{ dhash: string, phash?: string | null }} fingerprint
   * @param {{ threshold?: number, phashThreshold?: number, requireBoth?: boolean, limit?: number }} [options]
   * @returns {Array<Record<string, unknown> & { dhash_distance: number, phash_distance: number | null, similarity: number }>}
   */
  findSimilar(fingerprint, options = {}) {
    const threshold = options.threshold ?? 24
    const phashThreshold = options.phashThreshold ?? 12
    const requireBoth = options.requireBoth ?? true
    const limit = options.limit ?? 10

    const candidates = this._allHashes.all(MAX_CANDIDATES)
    if (candidates.length === 0) return []

    const scored = []
    for (const row of candidates) {
      const hasPhash = row.has_phash === 1
      if (requireBoth && hasPhash && !fingerprint.phash) continue
      if (!passesCompositeGate(
        { dhash: fingerprint.dhash, phash: fingerprint.phash ?? null },
        { dhash: row.dhash, phash: hasPhash ? row.phash : null },
        { threshold, phashThreshold, requireBoth },
      )) continue
      const cmp = compareHashes(
        { dhash: fingerprint.dhash, phash: fingerprint.phash ?? null },
        { dhash: row.dhash, phash: hasPhash ? row.phash : null },
      )
      scored.push({ id: row.id, ...cmp })
    }

    scored.sort((a, b) => a.dhashDistance - b.dhashDistance)
    const top = scored.slice(0, limit)
    if (top.length === 0) return []

    const byId = this.db.prepare('SELECT * FROM images WHERE id = ?')
    return top.map((hit) => {
      const row = byId.get(hit.id)
      return {
        ...row,
        dhash_distance: hit.dhashDistance,
        phash_distance: hit.phashDistance,
        similarity: hit.similarity,
      }
    })
  }

  /**
   * 记一条图。若已有 attachment_id 或近似的记录，则累加命中次数而不是插新行。
   *
   * @param {object} image
   * @param {string} image.attachmentId
   * @param {string} image.dhash
   * @param {string} [image.ahash]
   * @param {string} [image.phash]
   * @param {number} [image.width]
   * @param {number} [image.height]
   * @param {number} [image.fileSize]
   * @param {string} [image.filePath]
   * @param {string} [image.sessionId]
   * @param {string} [image.platform]
   * @param {string} [image.userText]
   * @param {string} [image.summary]
   * @param {number} [threshold]
   * @param {number} [phashThreshold]
   * @param {boolean} [requireBoth]
   * @returns {{ row: Record<string, unknown>, created: boolean }}
   */
  record(image, options = {}) {
    const now = new Date().toISOString()

    const exact = image.attachmentId ? this.getByAttachment(image.attachmentId) : null
    if (exact) {
      this.touch(exact.id, image.userText, image.summary)
      return { row: { ...this.getById(exact.id), hit_count: exact.hit_count + 1 }, created: false }
    }

    const similar = this.findSimilar(
      { dhash: image.dhash, phash: image.phash ?? null },
      {
        threshold: options.threshold ?? 24,
        phashThreshold: options.phashThreshold ?? 12,
        requireBoth: options.requireBoth ?? true,
        limit: 1,
      },
    )
    if (similar.length > 0) {
      this.touch(similar[0].id, image.userText, image.summary)
      return { row: this.getById(similar[0].id), created: false }
    }

    const info = this._insert.run(
      image.attachmentId ?? null,
      image.dhash,
      image.ahash ?? null,
      image.phash ?? null,
      image.width ?? null,
      image.height ?? null,
      image.fileSize ?? null,
      image.filePath ?? null,
      image.sessionId ?? null,
      image.platform ?? null,
      trim(image.userText, 500),
      trim(image.summary, 500),
      now,
      now,
    )
    const id = Number(info.lastInsertRowid)
    return { row: this.getById(id), created: true }
  }

  /**
   * 命中已有记录：次数 +1、刷新最后出现时间，并把新信息并进摘要。
   * @param {number} id
   * @param {string} [userText]
   * @param {string} [summary]
   */
  touch(id, userText, summary) {
    const row = this.getById(id)
    if (row === null) return
    const now = new Date().toISOString()
    const nextUser = merge(row.user_text, userText, 500)
    const nextSummary = merge(row.summary, summary, 500)
    this.db
      .prepare(
        `UPDATE images
           SET hit_count = hit_count + 1, last_seen_at = ?, user_text = ?, summary = ?
         WHERE id = ?`,
      )
      .run(now, nextUser, nextSummary, id)
  }

  /**
   * @param {number} id
   */
  getById(id) {
    return this.db.prepare('SELECT * FROM images WHERE id = ?').get(id) ?? null
  }

  /**
   * @param {string} query 关键词，匹配 user_text / summary / file_path
   * @param {number} [limit]
   */
  search(query, limit = 20) {
    const like = `%${query}%`
    return this.db
      .prepare(
        `SELECT * FROM images
          WHERE user_text LIKE ? OR summary LIKE ? OR file_path LIKE ?
          ORDER BY last_seen_at DESC LIMIT ?`,
      )
      .all(like, like, like, limit)
  }

  /** @param {number} limit */
  recent(limit = 20) {
    return this.db.prepare('SELECT * FROM images ORDER BY last_seen_at DESC LIMIT ?').all(limit)
  }

  /** @param {number} id */
  deleteById(id) {
    const info = this.db.prepare('DELETE FROM images WHERE id = ?').run(id)
    return info.changes > 0
  }

  stats() {
    const total = this.count()
    const withSummary = this.db
      .prepare("SELECT COUNT(*) AS n FROM images WHERE summary IS NOT NULL AND summary != ''")
      .get().n
    const hits = this.db.prepare('SELECT COALESCE(SUM(hit_count), 0) AS n FROM images').get().n
    return { total, withSummary, totalHits: hits, path: this.path }
  }
}

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {string | null}
 */
function trim(value, max) {
  if (typeof value !== 'string') return null
  const clean = value.replace(/\s+/gu, ' ').trim()
  if (clean === '') return null
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

/**
 * 把新摘要拼到旧摘要后面（Python 版用的「；」间隔）。
 * @param {string | null} old
 * @param {string | null | undefined} next
 * @param {number} max
 */
function merge(old, next, max) {
  const incoming = trim(next, max)
  if (incoming === null) return old
  if (old === null || old === '') return incoming
  if (old.includes(incoming)) return old
  const combined = `${old}；${incoming}`
  return combined.length > max ? combined.slice(0, max) : combined
}

export { hammingDistance }
