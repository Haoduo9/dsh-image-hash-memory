/**
 * evidence.js — 从 DSH 消息里认出「这一轮用户带了哪些图」，以及拿到图的字节。
 *
 * DSH 的图片走 attachments 服务，消息里只有结构化的 ImageBlock：
 *   { type: 'image', attachment: { attachmentId: 'sha256:…', mediaType, width, height, … } }
 * 字节需要向 ctx.attachments.readImage(ref) 要，文件路径可能压根不存在。
 */

/**
 * 判断一条消息是不是「用户自己说的」（而不是运行时/工具注入的）。
 * @param {any} message
 */
export function isUserAuthored(message) {
  const kind = message?.source?.kind
  if (kind === 'user') return true
  // 某些版本的用户消息没有 source.kind，退化判断：不是工具/运行时来源
  return kind !== 'model' && kind !== 'tool' && kind !== 'system-prompt' && kind !== 'runtime-context'
}

/**
 * 取出消息里的纯文本。
 * @param {any} message
 * @returns {string}
 */
export function textOf(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  return blocks
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * 取出消息里的全部图片块。
 * @param {any} message
 * @returns {Array<{ attachmentId: string, mediaType?: string, width?: number, height?: number, name?: string }>}
 */
export function imagesOf(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  const out = []
  const seen = new Set()
  for (const block of blocks) {
    if (block?.type !== 'image') continue
    const ref = block.attachment
    if (ref === null || typeof ref !== 'object') continue
    const attachmentId = typeof ref.attachmentId === 'string' ? ref.attachmentId : ''
    if (attachmentId === '' || seen.has(attachmentId)) continue
    seen.add(attachmentId)
    out.push({
      attachmentId,
      mediaType: typeof ref.mediaType === 'string' ? ref.mediaType : undefined,
      width: typeof ref.width === 'number' ? ref.width : undefined,
      height: typeof ref.height === 'number' ? ref.height : undefined,
      name: typeof ref.name === 'string' ? ref.name : undefined,
    })
  }
  return out
}

/**
 * 在一批消息里找「本轮用户带来的新图」。
 * 从后往前找最后一条用户消息，只认它 —— 历史消息里的图不重复召回。
 *
 * @param {readonly any[]} messages
 * @returns {{ message: any | undefined, images: ReturnType<typeof imagesOf>, text: string }}
 */
export function currentTurnImages(messages) {
  const list = Array.isArray(messages) ? messages : []
  for (let i = list.length - 1; i >= 0; i--) {
    const message = list[i]
    if (!isUserAuthored(message)) continue
    const images = imagesOf(message)
    // 找到第一条「用户消息」就停：哪怕它没图，也说明这轮是纯文本
    return { message, images, text: textOf(message) }
  }
  return { message: undefined, images: [], text: '' }
}

/**
 * 拿图片原始字节。优先用宿主的 attachments 服务；失败返回 null。
 *
 * @param {any} attachmentsCtx ctx.attachments
 * @param {{ attachmentId: string, mediaType?: string, width?: number, height?: number, name?: string }} ref
 * @param {AbortSignal} [signal]
 * @returns {Promise<Uint8Array | null>}
 */
export async function readImageBytes(attachmentsCtx, ref, signal) {
  if (attachmentsCtx === null || typeof attachmentsCtx !== 'object') return null
  try {
    const stored = await attachmentsCtx.readImage(
      {
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType ?? 'image/png',
        bytes: 0,
        width: ref.width ?? 0,
        height: ref.height ?? 0,
        ...(ref.name === undefined ? {} : { name: ref.name }),
      },
      signal,
    )
    if (stored && stored.data instanceof Uint8Array) return stored.data
    if (stored && ArrayBuffer.isView(stored.data)) {
      return new Uint8Array(stored.data.buffer, stored.data.byteOffset, stored.data.byteLength)
    }
    return null
  } catch {
    return null
  }
}
