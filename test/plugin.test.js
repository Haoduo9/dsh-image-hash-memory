/**
 * test/plugin.test.js — 用假的 Cordis 上下文验证插件接线。
 *
 * 不启动真正的 DSH，只把 ctx 需要的那几个方法做出来：
 *   inject / effect / on / get / logger，然后手动戳事件。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { apply } from '../lib/index.js'

const PNG = new Uint8Array(readFileSync(new URL('./fixtures/rgb.png', import.meta.url)))
const PNG2 = new Uint8Array(readFileSync(new URL('./fixtures/other.png', import.meta.url)))

/** 造一个够用的假 ctx */
function fakeContext({ withBytes = true } = {}) {
  const listeners = new Map()
  const injections = []
  const tools = []
  const effectDisposers = []
  const promptContexts = []

  const ctx = {
    logger: { warn() {}, info() {}, error() {} },
    on(event, listener) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(listener)
      return () => {}
    },
    inject(services, callback) {
      const scope = {
        systemPrompt: {
          context(spec) {
            promptContexts.push(spec)
            return () => {}
          },
          section(spec) {
            promptContexts.push(spec)
            return () => {}
          },
        },
        tools: {
          register(definition) {
            tools.push(definition)
            return () => {}
          },
        },
        effect(fn) {
          const disposer = fn()
          if (typeof disposer === 'function') effectDisposers.push(disposer)
          return () => {}
        },
      }
      callback(scope)
      return () => {}
    },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') effectDisposers.push(disposer)
      return () => {}
    },
    get(service) {
      if (service === 'attachments') {
        if (!withBytes) return undefined
        return {
          async readImage(ref) {
            if (ref.attachmentId === 'sha256:first') return { ref, data: PNG }
            if (ref.attachmentId === 'sha256:second') return { ref, data: PNG2 }
            return { ref, data: PNG }
          },
        }
      }
      return undefined
    },
    emit(event, payload) {
      for (const listener of listeners.get(event) ?? []) listener(payload)
    },
    async waterfall(event, payload) {
      let next = async () => payload.decision
      for (const listener of [...(listeners.get(event) ?? [])].reverse()) {
        const current = next
        next = () => listener(payload, current)
      }
      return next()
    },
    _listeners: listeners,
    _tools: tools,
    _promptContexts: promptContexts,
    _effects: effectDisposers,
  }
  return ctx
}

/** 造一条带图的消息 */
function userMessage(attachmentId, text = '看看这张图') {
  return {
    role: 'user',
    source: { kind: 'user' },
    content: [
      { type: 'text', text },
      {
        type: 'image',
        attachment: { attachmentId, mediaType: 'image/png', width: 400, height: 300 },
      },
    ],
  }
}

/**
 * @param {object} options
 */
async function boot(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ihm-'))
  const dbPath = join(dir, 'test.db')
  const ctx = fakeContext(options)
  apply(ctx, {
    dbPath,
    debug: false,
    ...options.config,
  })
  return { ctx, dbPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function sessionAgent(id = 'sess-1') {
  return { session: { header: { id }, events: [] } }
}

test('注册了 tools 与 systemPrompt.context', async () => {
  const { ctx, cleanup } = await boot()
  try {
    assert.equal(ctx._tools.length, 1)
    assert.equal(ctx._tools[0].name, 'image_memory')
    assert.ok(ctx._promptContexts.length >= 1)
    assert.ok(ctx._listeners.has('agent/pre-step'))
  } finally {
    cleanup()
  }
})

test('第一张图入库，注入文本为空', async () => {
  const { ctx, cleanup } = await boot()
  try {
    const payload = { agent: sessionAgent(), turn: 1, step: 1, signal: new AbortController().signal }
    const decision = { kind: 'enter', messages: [userMessage('sha256:first')] }
    await ctx.waterfall('agent/pre-step', { ...payload, decision })

    const tool = ctx._tools[0]
    const stats = await tool.execute({ action: 'stats' })
    assert.equal(stats.total, 1)
  } finally {
    cleanup()
  }
})

test('同一张图再来一次：命中并产生注入文本', async () => {
  const { ctx, cleanup } = await boot()
  try {
    const agent = sessionAgent()
    const signal = new AbortController().signal
    const first = { kind: 'enter', messages: [userMessage('sha256:first')] }
    await ctx.waterfall('agent/pre-step', { agent, turn: 1, step: 1, signal, decision: first })

    const second = { kind: 'enter', messages: [userMessage('sha256:first', '这张我之前发过吗')] }
    await ctx.waterfall('agent/pre-step', { agent, turn: 2, step: 1, signal, decision: second })

    // 通过 context provider 读出注入文本
    const spec = ctx._promptContexts.find((entry) => entry.name === 'image-hash-memory:recall')
    const text = spec.text({ agent })
    assert.ok(text.includes('累计 2 次'), `注入文本应显示次数：${text}`)
    assert.ok(text.includes('这张我之前发过吗'), '注入文本应带上当前描述')
  } finally {
    cleanup()
  }
})

test('纯文本轮次会清掉上一轮的注入', async () => {
  const { ctx, cleanup } = await boot()
  try {
    const agent = sessionAgent()
    const signal = new AbortController().signal
    await ctx.waterfall('agent/pre-step', {
      agent, turn: 1, step: 1, signal,
      decision: { kind: 'enter', messages: [userMessage('sha256:first')] },
    })
    await ctx.waterfall('agent/pre-step', {
      agent, turn: 2, step: 1, signal,
      decision: { kind: 'enter', messages: [userMessage('sha256:first')] },
    })
    const spec = ctx._promptContexts.find((entry) => entry.name === 'image-hash-memory:recall')
    assert.notEqual(spec.text({ agent }), '')

    await ctx.waterfall('agent/pre-step', {
      agent, turn: 3, step: 1, signal,
      decision: { kind: 'enter', messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '纯聊天' }] }] },
    })
    assert.equal(spec.text({ agent }), '')
  } finally {
    cleanup()
  }
})

test('完全不同的图不会误命中', async () => {
  const { ctx, cleanup } = await boot()
  try {
    const agent = sessionAgent()
    const signal = new AbortController().signal
    await ctx.waterfall('agent/pre-step', {
      agent, turn: 1, step: 1, signal,
      decision: { kind: 'enter', messages: [userMessage('sha256:first')] },
    })
    await ctx.waterfall('agent/pre-step', {
      agent, turn: 2, step: 1, signal,
      decision: { kind: 'enter', messages: [userMessage('sha256:second')] },
    })
    const spec = ctx._promptContexts.find((entry) => entry.name === 'image-hash-memory:recall')
    const text = spec.text({ agent })
    assert.ok(text === '' || !text.includes('距离 0'), `不该命中：${text}`)

    const stats = await ctx._tools[0].execute({ action: 'stats' })
    assert.equal(stats.total, 2)
  } finally {
    cleanup()
  }
})

test('image_memory 工具：search / remember / forget / stats', async () => {
  const { ctx, cleanup } = await boot()
  try {
    const tool = ctx._tools[0]
    assert.deepEqual(await tool.execute({ action: 'stats' }), {
      total: 0, withSummary: 0, totalHits: 0, path: (await tool.execute({ action: 'stats' })).path,
    })

    const remembered = await tool.execute({
      action: 'remember',
      path: fileURLToPath(new URL('./fixtures/rgb.png', import.meta.url)),
      note: '这是一张测试图',
    })
    assert.equal(remembered.created, true)

    const found = await tool.execute({ action: 'search', query: '测试图' })
    assert.equal(found.count, 1)

    const deleted = await tool.execute({ action: 'forget', id: remembered.item.id })
    assert.equal(deleted.deleted, true)
    assert.equal((await tool.execute({ action: 'stats' })).total, 0)
  } finally {
    cleanup()
  }
})

test('拿不到附件字节时安全跳过', async () => {
  const { ctx, cleanup } = await boot({ withBytes: false })
  try {
    const agent = sessionAgent()
    const decision = { kind: 'enter', messages: [userMessage('sha256:first')] }
    await ctx.waterfall('agent/pre-step', { agent, turn: 1, step: 1, signal: new AbortController().signal, decision })
    const stats = await ctx._tools[0].execute({ action: 'stats' })
    assert.equal(stats.total, 0)
  } finally {
    cleanup()
  }
})
