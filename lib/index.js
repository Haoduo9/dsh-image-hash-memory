/**
 * index.js — dsh-image-hash-memory 宿主插件入口。
 *
 * 干什么：让模型记住「这张图之前见过没有」，跨会话、跨重启。
 *   - 每轮用户带图时，算 dHash / aHash / pHash，查本地 SQLite；
 *   - 命中就把「首次出现时间、发过几次、当时的对话」注入进上下文；
 *   - 没命中就入库，等助手说完话再把分析摘要回填；
 *   - 另外注册 image_memory 工具，让模型能主动查 / 记 / 改。
 *
 * 设计上沿用 workspace 里 dsh-hindsight-recall 的模式：
 *   agent/pre-step 拦截 → 缓存到 session → systemPrompt.context 每步渲染。
 * 好处是整条工具链里记忆都在，且不伪造用户消息、不改会话日志。
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

import { resolveConfig, setConfigSchema, DEFAULTS } from './config.js'
import {
  computeImageFingerprint,
  setImageDecoder,
  hammingDistance,
} from './hasher.js'
import { decodePng } from './png.js'
import { ImageMemoryStore, defaultDbPath } from './store.js'
import { currentTurnImages, imagesOf, isUserAuthored, readImageBytes, textOf } from './evidence.js'

// schemastery 只在 DSH 运行时可用；脱机（单测）时解析不到就不带 Config，
// 只影响「设置页能渲染表单」，不影响功能。
let Config
try {
  const mod = await import('./schema.js')
  Config = mod.Config
  setConfigSchema(Config)
} catch (error) {
  Config = undefined
  void error
}

export { Config }
export { DEFAULTS }
export const name = 'dsh-image-hash-memory'
export const inject = ['attachments']

const LOG_NAME = 'image-hash-memory.log'
const INJECT_HEADER = '## 视觉记忆（image-hash-memory 自动检索）'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Partial<ReturnType<typeof resolveConfig>>} rawConfig
 */
export function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)
  const debugFile = join(homedir(), '.dsh', 'state', LOG_NAME)

  const debug = (...parts) => {
    if (!config.debug) return
    try {
      mkdirSync(dirname(debugFile), { recursive: true })
      appendFileSync(debugFile, `${new Date().toISOString()} ${parts.join(' ')}\n`)
    } catch {
      /* 诊断日志失败不影响主流程 */
    }
  }

  const dbPath = typeof config.dbPath === 'string' && config.dbPath.trim() !== ''
    ? config.dbPath.replace(/^~(?=$|\/)/u, homedir())
    : defaultDbPath()

  /** @type {ImageMemoryStore} */
  let store
  let storeError = null
  try {
    store = new ImageMemoryStore(dbPath)
    debug(`store opened at ${dbPath}`)
  } catch (error) {
    // 库开不出来就整体降级：工具照常注册，但每个调用都如实报错
    storeError = error
    store = null
    ctx.logger?.warn?.(`[image-hash-memory] 数据库打开失败：${error?.message ?? error}`)
  }

  ctx.effect(() => () => store?.close())

  // 解码器：PNG 用内置纯 JS 实现；JPEG/WebP 交给宿主的 attachments 服务
  // （它内部有 sharp，但只暴露「读字节」，所以在 evidence.readImageBytes 之后
  //  如果 PNG 解不了，就跳过 —— 见 decodeForHash）。
  setImageDecoder(async (bytes) => decodePng(bytes))

  /** @type {Map<string, { prompt: string, images: Array<object>, text: string, pending: Set<string> }>} */
  const cache = new Map()

  /**
   * 给一张图算指纹；解不出来返回 null。
   * @param {Uint8Array} bytes
   * @param {string} [mediaType]
   */
  async function fingerprintOf(bytes, mediaType) {
    try {
      return await computeImageFingerprint(bytes, mediaType)
    } catch (error) {
      debug(`fingerprint failed: ${error?.message ?? error}`)
      return null
    }
  }

  /**
   * 把一份指纹和库里的记录比一比。
   * @param {{ dhash: string, phash?: string | null }} fp
   */
  function lookup(fp) {
    if (store === null) return []
    return store.findSimilar(
      { dhash: fp.dhash, phash: fp.phash ?? null },
      {
        threshold: config.hammingThreshold,
        phashThreshold: config.phashThreshold,
        requireBoth: config.enablePhash && config.verificationMode === 'composite',
        limit: config.maxInject,
      },
    )
  }

  /**
   * 渲染注入文本。
   * @param {Array<Record<string, any>>} hits
   */
  function renderInjection(hits) {
    const lines = [INJECT_HEADER]
    for (const [index, hit] of hits.entries()) {
      const seen = hit.hit_count ?? 1
      const first = formatTime(hit.first_seen_at)
      const last = formatTime(hit.last_seen_at)
      const phash = hit.phash_distance === null ? '' : `，pHash 距离 ${hit.phash_distance}`
      const summary = String(hit.summary ?? '').trim()
      const userText = String(hit.user_text ?? '').trim()
      const parts = [`- 图${index + 1}：与历史图片高度相似（dHash 距离 ${hit.dhash_distance}${phash}）`]
      parts.push(`  首次出现于 ${first}，最近一次 ${last}，累计 ${seen} 次`)
      if (userText !== '') parts.push(`  当时用户说的是：${userText}`)
      if (summary !== '') parts.push(`  上次的分析记录：${summary}`)
      if (userText === '' && summary === '') parts.push('  暂无文字记录，可以直接目视核对')
      lines.push(parts.join('\n'))
    }
    lines.push('以上是本地感知哈希库的检索结果；与当前图片明显不符时以当前图片为准。')
    const text = lines.join('\n')
    const max = config.maxInjectChars
    return text.length > max ? `${text.slice(0, max)}…` : text
  }

  // -------------------------------------------------------------------------
  // 注入通道
  // -------------------------------------------------------------------------

  let contextReady = false
  try {
    ctx.inject(['systemPrompt'], (scope) => {
      scope.systemPrompt.context({
        name: 'image-hash-memory:recall',
        order: 170,
        interpolate: false,
        text: (assembleContext) => {
          const id = assembleContext?.agent?.session?.header?.id
          if (id === undefined || id === null) return ''
          return cache.get(String(id))?.text ?? ''
        },
      })
      contextReady = true
      debug('systemPrompt.context registered')
    })
  } catch (error) {
    ctx.logger?.warn?.(`[image-hash-memory] systemPrompt.context 不可用：${error?.message ?? error}`)
  }

  // -------------------------------------------------------------------------
  // 每轮：认图 / 查库 / 记新图
  // -------------------------------------------------------------------------

  const attachments = ctx.get('attachments')

  /** @returns {Promise<{ images: Array<object>, text: string } | null>} */
  async function inspectTurn(payload, decision) {
    const messages = Array.isArray(decision?.messages) ? decision.messages : []
    const turn = currentTurnImages(messages)
    if (turn.images.length === 0) return null
    if (!isUserAuthored(turn.message)) return null

    /** @type {Array<Record<string, any>>} */
    const items = []
    for (const ref of turn.images) {
      const bytes = await readImageBytes(attachments, ref, payload?.signal)
      if (bytes === null) {
        debug(`no bytes for ${ref.attachmentId}`)
        continue
      }
      const fp = await fingerprintOf(bytes, ref.mediaType)
      if (fp === null) {
        debug(`no fingerprint for ${ref.attachmentId} (${ref.mediaType})`)
        continue
      }

      const hits = config.autoRecall ? lookup(fp) : []
      let hit = hits[0]
      let created = false

      if (config.autoRecord) {
        const recorded = store.record(
          {
            attachmentId: ref.attachmentId,
            dhash: fp.dhash,
            ahash: fp.ahash,
            phash: fp.phash,
            width: fp.width,
            height: fp.height,
            fileSize: fp.filesize,
            sessionId: String(payload?.agent?.session?.header?.id ?? ''),
            userText: turn.text,
          },
          {
            threshold: config.hammingThreshold,
            phashThreshold: config.phashThreshold,
            requireBoth: config.enablePhash && config.verificationMode === 'composite',
          },
        )
        created = recorded.created
        // record() 返回的是写完之后的记录（命中次数已 +1），优先用它；
        // 只有关掉 autoRecord 时才退回 findSimilar 的结果。
        if (recorded.row !== null && recorded.row !== undefined) hit = recorded.row
      }

      items.push({ ref, fp, hit, created })
      debug(`image ${ref.attachmentId} d=${fp.dhash} hit=${hit?.id ?? 'none'} created=${created}`)
    }

    if (items.length === 0) return null

    /** @type {Array<Record<string, any>>} */
    const hitsForInject = []
    for (const item of items) {
      if (item.hit === undefined || item.hit === null) continue
      if (hitsForInject.some((other) => other.id === item.hit.id)) continue
      hitsForInject.push(item.hit)
    }

    return {
      images: items,
      text: hitsForInject.length > 0 ? renderInjection(hitsForInject) : '',
    }
  }

  try {
    ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      if (decision?.kind !== 'enter') return decision
      if (!config.enabled || payload?.signal?.aborted) return decision
      if (!contextReady || store === null) return decision

      const sessionId = String(payload?.agent?.session?.header?.id ?? '')
      if (sessionId === '') return decision

      try {
        const result = await inspectTurn(payload, decision)
        if (result === null) {
          // 纯文本轮次：清掉上一轮的注入，别让旧记忆在这轮继续挂钩
          const previous = cache.get(sessionId)
          if (previous !== undefined && previous.text !== '') {
            cache.set(sessionId, { prompt: '', images: [], text: '', pending: new Set() })
            debug(`cleared injection session=${sessionId}`)
          }
          return decision
        }

        const turn = currentTurnImages(decision.messages)
        const pending = new Set(
          result.images.filter((item) => item.created).map((item) => item.ref.attachmentId),
        )
        cache.set(sessionId, {
          prompt: turn.text,
          images: result.images.map((item) => item.ref),
          text: result.text,
          pending,
        })
        debug(`inject chars=${result.text.length} session=${sessionId} pending=${pending.size}`)
      } catch (error) {
        debug(`pre-step failed: ${error?.message ?? error}`)
      }
      return decision
    }, { prepend: true })
  } catch (error) {
    ctx.logger?.warn?.(`[image-hash-memory] agent/pre-step 不可用：${error?.message ?? error}`)
  }

  // 助手说完话：给刚落库的图回填一段分析摘要
  try {
    ctx.on('agent/turn-stopping', (payload) => {
      if (!config.enabled || store === null) return
      const sessionId = String(payload?.agent?.session?.header?.id ?? '')
      const entry = cache.get(sessionId)
      if (entry === undefined || entry.pending.size === 0) return
      try {
        const summary = collectLastSummary(payload.agent)
        if (summary === '') return
        for (const attachmentId of entry.pending) {
          const row = store.getByAttachment(attachmentId)
          if (row !== null) store.touch(row.id, undefined, summary)
        }
        entry.pending.clear()
        debug(`summary backfilled session=${sessionId} chars=${summary.length}`)
      } catch (error) {
        debug(`backfill failed: ${error?.message ?? error}`)
      }
    })
  } catch (error) {
    ctx.logger?.warn?.(`[image-hash-memory] agent/turn-stopping 不可用：${error?.message ?? error}`)
  }

  try {
    ctx.on('agent/disposed', (payload) => {
      const id = payload?.agent?.session?.header?.id
      if (id !== undefined && id !== null) cache.delete(String(id))
    })
  } catch {
    /* ignore */
  }

  // -------------------------------------------------------------------------
  // image_memory 工具
  // -------------------------------------------------------------------------

  try {
    ctx.inject(['tools'], (scope) => {
      scope.tools.register({
        name: 'image_memory',
        description: [
          '查询 / 记录本地视觉记忆库（感知哈希 dHash+pHash 相似检索）。',
          'action=search 用关键词找以前见过的图；',
          'action=lookup 给一张图片路径查库里的相似记录；',
          'action=remember 把一张图连同说明写进库；',
          'action=stats 看库存量；action=forget 按 id 删除。',
        ].join(''),
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['search', 'lookup', 'remember', 'stats', 'forget'],
              description: '要做的操作',
            },
            query: { type: 'string', description: 'search 用的关键词' },
            path: { type: 'string', description: 'lookup / remember 用的本地图片路径' },
            note: { type: 'string', description: 'remember 时附带的说明或分析结论' },
            id: { type: 'number', description: 'forget 要删除的记录 id' },
          },
          required: ['action'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object', additionalProperties: true },
          render(_args, value) {
            return [{ type: 'text', text: renderToolResult(value) }]
          },
        },
        async execute(args) {
          return runTool(args)
        },
      })
      debug('image_memory tool registered')
    })
  } catch (error) {
    ctx.logger?.warn?.(`[image-hash-memory] tools 注册失败：${error?.message ?? error}`)
  }

  /**
   * @param {any} args
   */
  async function runTool(args) {
    if (store === null) {
      throw new Error(`视觉记忆库不可用：${storeError?.message ?? '数据库未打开'}`)
    }
    const action = String(args?.action ?? '')
    switch (action) {
      case 'stats':
        return store.stats()
      case 'search': {
        const query = String(args?.query ?? '').trim()
        const rows = query === '' ? store.recent(20) : store.search(query, 20)
        return { count: rows.length, items: rows.map(publicRow) }
      }
      case 'lookup': {
        const file = String(args?.path ?? '')
        const bytes = await readLocalImage(file)
        const fp = await fingerprintOf(bytes)
        if (fp === null) throw new Error(`读不出图片（只支持 PNG）：${file}`)
        const hits = store.findSimilar(
          { dhash: fp.dhash, phash: fp.phash },
          {
            threshold: config.hammingThreshold,
            phashThreshold: config.phashThreshold,
            requireBoth: config.enablePhash && config.verificationMode === 'composite',
            limit: config.maxInject,
          },
        )
        return { fingerprint: fp, matched: hits.length, items: hits.map(publicRow) }
      }
      case 'remember': {
        const file = String(args?.path ?? '')
        const bytes = await readLocalImage(file)
        const fp = await fingerprintOf(bytes)
        if (fp === null) throw new Error(`读不出图片（只支持 PNG）：${file}`)
        const recorded = store.record({
          attachmentId: `file:${file}`,
          dhash: fp.dhash,
          ahash: fp.ahash,
          phash: fp.phash,
          width: fp.width,
          height: fp.height,
          fileSize: fp.filesize,
          filePath: file,
          summary: String(args?.note ?? ''),
        }, {
          threshold: config.hammingThreshold,
          phashThreshold: config.phashThreshold,
          requireBoth: config.enablePhash && config.verificationMode === 'composite',
        })
        return { created: recorded.created, item: publicRow(recorded.row) }
      }
      case 'forget': {
        const id = Number(args?.id)
        if (!Number.isFinite(id)) throw new Error('forget 需要 id')
        return { deleted: store.deleteById(id), id }
      }
      default:
        throw new Error(`未知 action：${action}`)
    }
  }
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/**
 * @param {string | null | undefined} value
 */
function formatTime(value) {
  if (typeof value !== 'string' || value === '') return '未知时间'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toISOString().replace('T', ' ').slice(0, 16)
}

/**
 * 只把库里的字段暴露给模型，别把内部 id 之外的东西全抖出去。
 * @param {Record<string, any>} row
 */
function publicRow(row) {
  if (row === null || typeof row !== 'object') return row
  const out = {}
  for (const key of [
    'id',
    'file_path',
    'user_text',
    'summary',
    'hit_count',
    'first_seen_at',
    'last_seen_at',
    'width',
    'height',
    'dhash_distance',
    'phash_distance',
    'similarity',
  ]) {
    if (row[key] !== undefined && row[key] !== null) out[key] = row[key]
  }
  return out
}

/**
 * 从本轮 assistant 的最后一条消息里抓一段摘要。
 * @param {any} agent
 */
function collectLastSummary(agent) {
  const session = agent?.session
  const events = session?.events
  if (!Array.isArray(events)) return ''
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event?.type !== 'message' || event?.message?.role !== 'assistant') continue
    const text = textOf(event.message)
    if (text !== '') return text.replace(/\s+/gu, ' ').slice(0, 400)
  }
  return ''
}

/**
 * @param {string} file
 * @returns {Promise<Uint8Array>}
 */
async function readLocalImage(file) {
  if (typeof file !== 'string' || file.trim() === '') throw new Error('需要图片路径')
  const bytes = readFileSync(file)
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

/**
 * @param {any} value
 */
function renderToolResult(value) {
  if (value === null || typeof value !== 'object') return String(value)
  const lines = []
  if (Array.isArray(value.items)) {
    lines.push(`共 ${value.count ?? value.matched ?? value.items.length} 条：`)
    for (const item of value.items) {
      const time = formatTime(item.first_seen_at)
      const summary = item.summary ?? item.user_text ?? '（无说明）'
      const dist = item.dhash_distance === undefined ? '' : ` · dHash 距离 ${item.dhash_distance}`
      lines.push(`- #${item.id}（首次 ${time}，${item.hit_count ?? 1} 次${dist}）${summary}`)
    }
    if (value.fingerprint !== undefined) {
      lines.push(`指纹：dHash ${value.fingerprint.dhash} · pHash ${value.fingerprint.phash} · ${value.fingerprint.width}x${value.fingerprint.height}`)
    }
    return lines.join('\n')
  }
  if (value.item !== undefined) {
    return `${value.created ? '已新增' : '已并入已有记录'}：#${value.item.id} ${value.item.summary ?? ''}`.trim()
  }
  return JSON.stringify(value, null, 2)
}

export { hammingDistance, imagesOf }
