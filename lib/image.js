/**
 * image.js — 按文件头魔数分发到对应的解码器。
 *
 * DSH 的 attachments 只给字节、不给文件路径，所以不能靠扩展名判断。
 * 目前支持 PNG（内置解码器）与 JPEG（内置 baseline 解码器）。
 * WebP / GIF 会明确抛错，由上层静默跳过。
 */

import { decodePng } from './png.js'
import { decodeJpeg } from './jpeg.js'

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<{ width: number, height: number, data: Uint8ClampedArray }>}
 */
export async function decodeImage(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes)
  if (bytes.byteLength < 4) throw new Error('image too short')

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return decodePng(bytes)
  }

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return decodeJpeg(bytes)
  }

  // RIFF....WEBP
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    throw new Error('WebP decoding is not supported yet')
  }

  // GIF87a / GIF89a
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    throw new Error('GIF decoding is not supported yet')
  }

  throw new Error('unsupported image format')
}

/**
 * 只探测格式名，不真的解码。
 * @param {Uint8Array} bytes
 * @returns {'png' | 'jpeg' | 'webp' | 'gif' | 'unknown'}
 */
export function sniffFormat(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 4) return 'unknown'
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg'
  if (
    bytes.byteLength >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return 'webp'
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif'
  return 'unknown'
}
