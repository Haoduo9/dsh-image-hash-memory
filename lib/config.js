/**
 * config.js — 插件配置 schema（Host 与未来设置页共用）。
 *
 * 设置页的预留位：这里声明的每个字段都会被 DSH 的 settings 服务投影成
 * 「设置 → 插件」里的表单。以后要做自定义设置页时，注册
 * `settings.configure({ auto: false })` 并自己实现 UI，这些字段不用改。
 *
 * schemastery 由运行时（DSH profile）提供。脱离 DSH 单独跑测试时它可能
 * 解析不到，这时退化成纯 JS 的默认值合并，保证模块照样能加载、逻辑照样可测。
 */

/** 全部字段的默认值 —— 单文件里的唯一权威来源 */
export const DEFAULTS = {
  enabled: true,
  hammingThreshold: 24,
  enablePhash: true,
  phashThreshold: 12,
  verificationMode: 'composite',
  autoRecall: true,
  autoRecord: true,
  maxInject: 3,
  maxInjectChars: 1200,
  dbPath: '',
  debug: false,
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Math.round(value)))
}

/**
 * 纯 JS 校验/补默认值，语义与下面的 schemastery 定义一一对应。
 * @param {Record<string, any>} [raw]
 * @returns {typeof DEFAULTS}
 */
export function resolveConfig(raw = {}) {
  const out = { ...DEFAULTS }
  const input = raw !== null && typeof raw === 'object' ? raw : {}

  for (const key of ['enabled', 'enablePhash', 'autoRecall', 'autoRecord', 'debug']) {
    if (typeof input[key] === 'boolean') out[key] = input[key]
  }
  if (input.verificationMode === 'composite' || input.verificationMode === 'dhash') {
    out.verificationMode = input.verificationMode
  }
  if (Number.isFinite(input.hammingThreshold)) out.hammingThreshold = clamp(input.hammingThreshold, 0, 64)
  if (Number.isFinite(input.phashThreshold)) out.phashThreshold = clamp(input.phashThreshold, 0, 64)
  if (Number.isFinite(input.maxInject)) out.maxInject = clamp(input.maxInject, 1, 10)
  if (Number.isFinite(input.maxInjectChars)) out.maxInjectChars = clamp(input.maxInjectChars, 100, 4000)
  if (typeof input.dbPath === 'string') out.dbPath = input.dbPath.trim()
  return out
}

/** @type {any} 真正的 schemastery schema；DSH 里由 index.js 注入 */
let configSchema = null

/**
 * 由 index.js 在 DSH 运行时调用，传入真正的 schemastery schema。
 * @param {any} schema
 */
export function setConfigSchema(schema) {
  configSchema = schema
}

/**
 * 拿当前生效的 Config（schemastery schema 或 undefined）。
 */
export function getConfigSchema() {
  return configSchema ?? undefined
}

export { configSchema as Config }
