/**
 * png.js — 零依赖 PNG 解码器（RGBA）。
 *
 * 只做感知哈希需要的那一层：解出完整像素。支持全部 5 种颜色类型、
 * 1/2/4/8/16 位深、Adam7 隔行扫描。不做色彩管理、不做 ICC 转换 ——
 * 对 dHash/pHash 来说 sRGB 近似已经足够。
 */

/**
 * @param {Uint8Array} bytes
 * @returns {Promise<{ width: number, height: number, data: Uint8ClampedArray }>}
 */
export async function decodePng(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 8 || view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a) {
    throw new Error('not a PNG')
  }

  let offset = 8
  /** @type {Uint8Array | null} */
  let palette = null
  /** @type {Uint8Array | null} */
  let trns = null
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat = []

  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    )
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd > bytes.length) break

    if (type === 'IHDR') {
      width = view.getUint32(dataStart)
      height = view.getUint32(dataStart + 4)
      bitDepth = bytes[dataStart + 8]
      colorType = bytes[dataStart + 9]
      interlace = bytes[dataStart + 12]
    } else if (type === 'PLTE') {
      palette = bytes.subarray(dataStart, dataEnd)
    } else if (type === 'tRNS') {
      trns = bytes.subarray(dataStart, dataEnd)
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(dataStart, dataEnd))
    } else if (type === 'IEND') {
      break
    }
    offset = dataEnd + 4 // 跳过 CRC
  }

  if (width <= 0 || height <= 0) throw new Error('PNG has no dimensions')
  if (idat.length === 0) throw new Error('PNG has no IDAT')

  const compressed = concat(idat)
  const raw = await inflate(compressed)

  const channels = channelsOf(colorType)
  const bitsPerPixel = channels * bitDepth
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8))
  const out = new Uint8ClampedArray(width * height * 4)

  if (interlace === 0) {
    const stride = Math.ceil((width * bitsPerPixel) / 8)
    const expected = (stride + 1) * height
    if (raw.length < expected) throw new Error('PNG data truncated')
    const lines = unfilter(raw, 0, stride, height, bpp)
    expand(lines, width, height, colorType, bitDepth, palette, trns, out, width, 0, 0, 1, 1)
  } else {
    // Adam7：7 个 pass，每个 pass 有自己的子图尺寸
    const passes = [
      [0, 0, 8, 8],
      [4, 0, 8, 8],
      [0, 4, 4, 8],
      [2, 0, 4, 4],
      [0, 2, 2, 4],
      [1, 0, 2, 2],
      [0, 1, 1, 2],
    ]
    let cursor = 0
    for (const [x0, y0, dx, dy] of passes) {
      const pw = Math.ceil((width - x0) / dx)
      const ph = Math.ceil((height - y0) / dy)
      if (pw <= 0 || ph <= 0) continue
      const stride = Math.ceil((pw * bitsPerPixel) / 8)
      const need = (stride + 1) * ph
      if (cursor + need > raw.length) throw new Error('PNG Adam7 data truncated')
      const lines = unfilter(raw, cursor, stride, ph, bpp)
      expand(lines, pw, ph, colorType, bitDepth, palette, trns, out, width, x0, y0, dx, dy)
      cursor += need
    }
  }

  return { width, height, data: out }
}

function channelsOf(colorType) {
  switch (colorType) {
    case 0: return 1 // 灰度
    case 2: return 3 // RGB
    case 3: return 1 // 调色板
    case 4: return 2 // 灰度 + alpha
    case 6: return 4 // RGBA
    default: throw new Error(`unsupported PNG color type ${colorType}`)
  }
}

function concat(parts) {
  let total = 0
  for (const part of parts) total += part.byteLength
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.byteLength
  }
  return out
}

async function inflate(data) {
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate'))
  const buffer = await new Response(stream).arrayBuffer()
  return new Uint8Array(buffer)
}

/**
 * 反滤波（每行开头一个 filter type）。
 * @returns {Uint8Array[]} 每行去滤波后的字节
 */
function unfilter(raw, start, stride, rows, bpp) {
  const lines = []
  let previous = new Uint8Array(stride)
  let cursor = start
  for (let y = 0; y < rows; y++) {
    const filter = raw[cursor]
    const line = raw.subarray(cursor + 1, cursor + 1 + stride)
    const out = new Uint8Array(stride)
    for (let i = 0; i < stride; i++) {
      const x = line[i]
      const a = i >= bpp ? out[i - bpp] : 0
      const b = previous[i]
      const c = i >= bpp ? previous[i - bpp] : 0
      let value
      switch (filter) {
        case 0: value = x; break
        case 1: value = x + a; break
        case 2: value = x + b; break
        case 3: value = x + ((a + b) >> 1); break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
          value = x + pred
          break
        }
        default: throw new Error(`bad PNG filter ${filter}`)
      }
      out[i] = value & 0xff
    }
    lines.push(out)
    previous = out
    cursor += stride + 1
  }
  return lines
}

/**
 * 把每个 pass 的样本展开成 RGBA，写进目标缓冲。
 */
function expand(lines, pw, ph, colorType, bitDepth, palette, trns, out, outWidth, x0, y0, dx, dy) {
  const maxVal = (1 << bitDepth) - 1
  const sampleAt = (line, index) => {
    if (bitDepth === 8) return line[index]
    if (bitDepth === 16) return (line[index * 2] << 8) | line[index * 2 + 1]
    const bitPos = index * bitDepth
    const byte = line[bitPos >> 3]
    const shift = 8 - bitDepth - (bitPos & 7)
    return (byte >> shift) & maxVal
  }
  const to8 = (v) => (bitDepth === 8 ? v : Math.round((v * 255) / maxVal))

  for (let y = 0; y < ph; y++) {
    const line = lines[y]
    const oy = y0 + y * dy
    for (let x = 0; x < pw; x++) {
      const ox = x0 + x * dx
      if (ox >= outWidth || oy * outWidth + ox >= out.length / 4) continue
      const dst = (oy * outWidth + ox) * 4
      let r
      let g
      let b
      let a = 255
      if (colorType === 0) {
        r = g = b = to8(sampleAt(line, x))
        if (trns !== null && trns.length >= 2) {
          const key = (trns[0] << 8) | trns[1]
          if (sampleAt(line, x) === key) a = 0
        }
      } else if (colorType === 4) {
        r = g = b = to8(sampleAt(line, x * 2))
        a = to8(sampleAt(line, x * 2 + 1))
      } else if (colorType === 2) {
        r = to8(sampleAt(line, x * 3))
        g = to8(sampleAt(line, x * 3 + 1))
        b = to8(sampleAt(line, x * 3 + 2))
      } else if (colorType === 6) {
        r = to8(sampleAt(line, x * 4))
        g = to8(sampleAt(line, x * 4 + 1))
        b = to8(sampleAt(line, x * 4 + 2))
        a = to8(sampleAt(line, x * 4 + 3))
      } else if (colorType === 3) {
        const idx = sampleAt(line, x)
        if (palette === null) throw new Error('palette PNG without PLTE')
        r = palette[idx * 3]
        g = palette[idx * 3 + 1]
        b = palette[idx * 3 + 2]
        a = trns !== null && idx < trns.length ? trns[idx] : 255
      } else {
        r = g = b = 0
      }
      out[dst] = r
      out[dst + 1] = g
      out[dst + 2] = b
      out[dst + 3] = a
    }
  }
}
