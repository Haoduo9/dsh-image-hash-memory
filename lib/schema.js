/**
 * schema.js — 真正的 schemastery Config 定义。
 *
 * 单独一个文件：只有 DSH 运行时会加载它（那里 schemastery 一定可解析），
 * 单测和脱机环境不会 import 到它，避免「找不到 schemastery」把整个模块带崩。
 */

import z from '@deepseek-ai/schemastery'

/**
 * 每个字段都会出现在「设置 → 插件 → 图片感知记忆」的表单里。
 * 加字段时记得同步 lib/config.js 的 DEFAULTS 与 resolveConfig()。
 */
export const Config = z.object({
  /** 总开关：关掉后只保留 image_memory 工具，不再自动召回/自动记录 */
  enabled: z.boolean().default(true),

  /** dHash 汉明距离上限（0-64），越小越严格 */
  hammingThreshold: z.number().min(0).max(64).default(24),

  /** 是否启用 pHash 第二道门禁 */
  enablePhash: z.boolean().default(true),

  /** pHash 汉明距离上限（0-64） */
  phashThreshold: z.number().min(0).max(64).default(12),

  /**
   * 验证模式：
   *   composite - dHash 与 pHash 必须同时通过（默认，最抗误判）
   *   dhash     - 只看 dHash（更宽松，容易把调过色的图判成同一张）
   */
  verificationMode: z.union(['composite', 'dhash']).default('composite'),

  /** 本轮用户消息带图时，自动注入命中的视觉记忆 */
  autoRecall: z.boolean().default(true),

  /** 首次见到的图自动入库 */
  autoRecord: z.boolean().default(true),

  /** 每轮最多注入几条记忆 */
  maxInject: z.number().min(1).max(10).default(3),

  /** 注入文本上限（字符） */
  maxInjectChars: z.number().min(100).max(4000).default(1200),

  /** SQLite 库路径，留空用 ~/.dsh/state/image-hash-memory.db */
  dbPath: z.string().default(''),

  /** 打开后往 ~/.dsh/state/image-hash-memory.log 写诊断行 */
  debug: z.boolean().default(false),
})
