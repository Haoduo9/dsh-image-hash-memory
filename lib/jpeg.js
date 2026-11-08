/**
 * jpeg.js — 纯 JS baseline JPEG 解码器。
 *
 * 只做感知哈希需要的那一步：把 JPEG 解成 RGBA 像素。
 * 支持顺序（baseline / extended sequential）DCT 帧：
 *   - 1 / 3 分量（灰度 / YCbCr，也认 Adobe RGB）
 *   - 任意采样因子（4:4:4 / 4:2:2 / 4:2:0 / 4:1:1 …），色度上采样用双线性
 *   - 优化 Huffman 表（DHT）、DC 差分、AC 游程
 *   - restart marker（RSTn）
 * 不支持：渐进式、算术编码、无损（这些直接抛错，交给调用方跳过）。
 *
 * IDCT 用 AAN 整数近似（与 libjpeg 的 jidctint 同思路），精度足够哈希用。
 */

const ZIGZAG = new Int32Array([
  0, 1, 8, 16, 9, 2, 3, 10,
  17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34,
  27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36,
  29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46,
  53, 60, 61, 54, 47, 55, 62, 63,
])

/** 标准亮度 / 色度量化表（用于校验 SOF 里的表号，实际用文件里的） */
const STD_LUMA_QUANT = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
]
void STD_LUMA_QUANT

/** IDCT 的常数：sqrt(2)*cos(k*pi/16) 等（同 libjpeg jidctint） */
const CONST_BITS = 13
const PASS1_BITS = 2
const FIX_0_298631336 = 2446
const FIX_0_390180644 = 3196
const FIX_0_541196100 = 4433
const FIX_0_765366865 = 6270
const FIX_0_899976223 = 7373
const FIX_1_175875602 = 9633
const FIX_1_501321110 = 12299
const FIX_1_847759065 = 15137
const FIX_1_961570560 = 16069
const FIX_2_053119869 = 16819
const FIX_2_562915447 = 20995
const FIX_3_072711026 = 25172
/** 1/sqrt(2)，DC 通路的归一化系数 */
const FIX_0_707106781 = 5793

/**
 * 8x8 二维 IDCT（分离式两遍一维变换，浮点实现）。
 *
 * 用浮点而不是 AAN 整数近似：对感知哈希来说，一次 IDCT 的耗时可以忽略
 * （一张 4K 图也就几万块），换来的是没有归一化常数出错的空间。
 *
 * @param {Int32Array} blk 64 个反量化后的系数（自然顺序，行主序）
 * @param {Int32Array} out 输出 64 像素（stride 由调用方决定）
 * @param {number} stride
 */
const COS_TABLE = (() => {
  const table = new Float64Array(64)
  for (let x = 0; x < 8; x++) {
    for (let u = 0; u < 8; u++) {
      const cu = u === 0 ? Math.SQRT1_2 : 1
      table[x * 8 + u] = cu * Math.cos((2 * x + 1) * u * Math.PI / 16) * 0.5
    }
  }
  return table
})()

function idct8x8(blk, out, stride) {
  const tmp = new Float64Array(64)

  // 第一遍：对每一行做一维 IDCT
  for (let row = 0; row < 8; row++) {
    const o = row * 8
    const b = o
    for (let x = 0; x < 8; x++) {
      let sum = 0
      for (let u = 0; u < 8; u++) sum += COS_TABLE[x * 8 + u] * blk[b + u]
      tmp[o + x] = sum
    }
  }

  // 第二遍：对每一列做一维 IDCT，加 128 电平偏移，写进输出
  for (let col = 0; col < 8; col++) {
    for (let y = 0; y < 8; y++) {
      let sum = 0
      for (let v = 0; v < 8; v++) sum += COS_TABLE[y * 8 + v] * tmp[v * 8 + col]
      out[y * stride + col] = clamp8(Math.round(sum + 128))
    }
  }
}

function clamp8(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v
}

/**
 * 从字节流读 Huffman 表（DHT 段）。
 * @param {Uint8Array} bytes
 * @param {number} start
 * @param {number} end
 * @param {Map<number, {lookup: Int32Array, maxcode: Int32Array, mincode: Int32Array, valptr: Int32Array, values: Uint8Array, maxcodeAt: number}>} dcTables
 * @param {*} acTables
 */
function readHuffmanTables(bytes, start, end, dcTables, acTables) {
  let p = start
  while (p < end) {
    const tcTh = bytes[p++]
    const tc = tcTh >> 4
    const th = tcTh & 0x0f
    const counts = new Uint8Array(17)
    let total = 0
    for (let i = 1; i <= 16; i++) {
      counts[i] = bytes[p++]
      total += counts[i]
    }
    const values = bytes.subarray(p, p + total)
    p += total
    const table = buildHuffman(counts, values)
    if (tc === 0) dcTables.set(th, table)
    else acTables.set(th, table)
  }
}

/**
 * 由码长表 + 符号表构造解码表。
 * @param {Uint8Array} counts counts[1..16]
 * @param {Uint8Array} values
 */
function buildHuffman(counts, values) {
  const maxcode = new Int32Array(18).fill(-1)
  const mincode = new Int32Array(17)
  const valptr = new Int32Array(17)
  let code = 0
  let k = 0
  for (let len = 1; len <= 16; len++) {
    valptr[len] = k
    mincode[len] = code
    code += counts[len]
    k += counts[len]
    maxcode[len] = counts[len] ? code - 1 : -1
    code <<= 1
  }
  // 快表：9 位内一次出结果，超过就回退到逐位
  const lookup = new Int32Array(512).fill(-1)
  let c = 0
  let idx = 0
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < counts[len]; i++) {
      if (len <= 9) {
        const shift = 9 - len
        const base = c << shift
        const span = 1 << shift
        for (let j = 0; j < span; j++) lookup[base + j] = (len << 8) | (valptr[len] + i)
      }
      c++
      idx++
    }
    c <<= 1
  }
  // 超长码的兜底：记下最长码长
  let maxLen = 16
  for (let len = 16; len >= 1; len--) {
    if (counts[len]) { maxLen = len; break }
  }
  return { lookup, maxcode, mincode, valptr, values, maxLen }
}

/**
 * 主解码入口。
 * @param {Uint8Array} bytes
 * @returns {{ width: number, height: number, data: Uint8ClampedArray }}
 */
export function decodeJpeg(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('not a JPEG')

  let p = 2
  let width = 0
  let height = 0
  let frameComponents = null
  let quantTables = new Map()
  const dcTables = new Map()
  const acTables = new Map()
  let restartInterval = 0
  let adobeTransform = -1
  let sawSOF = false

  /** 所有扫描段的熵数据（顺序 DCT 可以多 scan） */
  const scans = []

  while (p < bytes.length) {
    // 找下一个 marker：跳过所有非 0xFF 字节，并把 0xFF 的填充字节吃掉
    while (p < bytes.length && bytes[p] !== 0xff) p++
    while (p < bytes.length && bytes[p] === 0xff) p++
    if (p >= bytes.length) break
    const marker = bytes[p++]
    if (marker === 0xd8 || marker === 0x01 || marker === 0x00) continue
    // RSTn 只在熵数据里出现；主循环碰到说明熵段边界算错了，跳过它继续
    if (marker >= 0xd0 && marker <= 0xd7) continue
    if (marker === 0xd9) break // EOI

    // 带长度字段的段
    const length = (bytes[p] << 8) | bytes[p + 1]
    const segStart = p + 2
    const segEnd = p + length

    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      // SOFn
      if (marker !== 0xc0 && marker !== 0xc1) {
        throw new Error(`unsupported JPEG frame type 0x${marker.toString(16)} (only sequential DCT)`)
      }
      const precision = bytes[segStart]
      if (precision !== 8) throw new Error(`unsupported JPEG precision ${precision}`)
      height = (bytes[segStart + 1] << 8) | bytes[segStart + 2]
      width = (bytes[segStart + 3] << 8) | bytes[segStart + 4]
      const count = bytes[segStart + 5]
      frameComponents = []
      for (let i = 0; i < count; i++) {
        const base = segStart + 6 + i * 3
        const id = bytes[base]
        const hv = bytes[base + 1]
        const h = hv >> 4
        const v = hv & 0x0f
        const tq = bytes[base + 2]
        frameComponents.push({ id, h, v, tq, blocksPerLine: 0, blocksPerColumn: 0 })
      }
      sawSOF = true
    } else if (marker === 0xc4) {
      readHuffmanTables(bytes, segStart, segEnd, dcTables, acTables)
    } else if (marker === 0xdb) {
      let q = segStart
      while (q < segEnd) {
        const pqTq = bytes[q++]
        const precision = pqTq >> 4
        const tq = pqTq & 0x0f
        const table = new Int32Array(64)
        if (precision === 0) {
          for (let i = 0; i < 64; i++) table[i] = bytes[q++]
        } else {
          for (let i = 0; i < 64; i++) {
            table[i] = (bytes[q] << 8) | bytes[q + 1]
            q += 2
          }
        }
        quantTables.set(tq, table)
      }
    } else if (marker === 0xdd) {
      restartInterval = (bytes[segStart] << 8) | bytes[segStart + 1]
    } else if (marker === 0xee) {
      // APP14 Adobe：判断颜色变换
      const sig = String.fromCharCode(...bytes.subarray(segStart, segStart + 5))
      if (sig === 'Adobe') {
        adobeTransform = bytes[segStart + 11]
      }
    } else if (marker === 0xda) {
      // SOS
      if (!sawSOF) throw new Error('SOS before SOF')
      const count = bytes[segStart]
      const components = []
      for (let i = 0; i < count; i++) {
        const base = segStart + 1 + i * 2
        const id = bytes[base]
        const tables = bytes[base + 1]
        const comp = frameComponents.find((candidate) => candidate.id === id)
        if (comp === undefined) throw new Error(`scan references unknown component ${id}`)
        components.push({ comp, dcTable: tables >> 4, acTable: tables & 0x0f })
      }
      const ss = bytes[segStart + 1 + count * 2]
      const se = bytes[segStart + 2 + count * 2]
      const ahAl = bytes[segStart + 3 + count * 2]
      if (ss !== 0 || se !== 63 || ahAl !== 0) {
        throw new Error('progressive JPEG is not supported (only baseline)')
      }
      // 熵数据一直读到下一个 marker（跳过 0xFF00 填充）
      let dataStart = segEnd
      let dataEnd = dataStart
      while (dataEnd < bytes.length) {
        if (bytes[dataEnd] === 0xff) {
          const next = bytes[dataEnd + 1]
          if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7)) break
          dataEnd += 2
          continue
        }
        dataEnd++
      }
      scans.push({ components, dataStart, dataEnd, bytes })
      p = dataEnd
    } else {
      p = segEnd
    }
  }

  if (!sawSOF || width <= 0 || height <= 0) throw new Error('JPEG has no valid frame header')
  if (frameComponents === null || frameComponents.length === 0) throw new Error('JPEG has no components')

  // 计算每个分量的块尺寸
  let maxH = 1
  let maxV = 1
  for (const comp of frameComponents) {
    maxH = Math.max(maxH, comp.h)
    maxV = Math.max(maxV, comp.v)
  }
  const mcusX = Math.ceil(width / (8 * maxH))
  const mcusY = Math.ceil(height / (8 * maxV))
  for (const comp of frameComponents) {
    comp.blocksPerLine = Math.ceil(Math.ceil((width * comp.h) / maxH) / 8)
    comp.blocksPerColumn = Math.ceil(Math.ceil((height * comp.v) / maxV) / 8)
    comp.planeWidth = mcusX * comp.h * 8
    comp.planeHeight = mcusY * comp.v * 8
    comp.plane = new Uint8Array(comp.planeWidth * comp.planeHeight)
  }

  // 解码每一轮 scan
  for (const scan of scans) {
    decodeScan(scan, {
      frameComponents,
      maxH,
      maxV,
      mcusX,
      mcusY,
      quantTables,
      dcTables,
      acTables,
      restartInterval,
      width,
      height,
    })
  }

  return assemble(frameComponents, width, height, adobeTransform)
}

/**
 * 熵解码 + 反量化 + IDCT，把结果写进各分量的 plane。
 */
function decodeScan(scan, ctx) {
  const { frameComponents, maxH, maxV, quantTables, dcTables, acTables, restartInterval } = ctx
  const reader = new BitReader(scan.bytes, scan.dataStart, scan.dataEnd)
  const preds = new Map()
  for (const entry of scan.components) preds.set(entry.comp, 0)

  const blocksPerMcu = scan.components.reduce((sum, entry) => sum + entry.comp.h * entry.comp.v, 0)
  const totalMcus = ctx.mcusX * ctx.mcusY
  let mcu = 0
  const blkOut = new Int32Array(64)
  const coeffs = new Int32Array(64)

  while (mcu < totalMcus) {
    if (restartInterval > 0 && mcu > 0 && mcu % restartInterval === 0) {
      reader.restart()
      for (const entry of scan.components) preds.set(entry.comp, 0)
    }
    const mcuX = mcu % ctx.mcusX
    const mcuY = (mcu / ctx.mcusX) | 0

    for (const entry of scan.components) {
      const comp = entry.comp
      const dcTable = dcTables.get(entry.dcTable)
      const acTable = acTables.get(entry.acTable)
      const quant = quantTables.get(comp.tq)
      if (dcTable === undefined || acTable === undefined) throw new Error('missing Huffman table')
      if (quant === undefined) throw new Error('missing quantization table')

      for (let by = 0; by < comp.v; by++) {
        for (let bx = 0; bx < comp.h; bx++) {
          coeffs.fill(0)
          // DC
          const t = reader.decodeHuffman(dcTable)
          const diff = t === 0 ? 0 : reader.receiveExtend(t)
          const pred = preds.get(comp) + diff
          preds.set(comp, pred)
          coeffs[0] = pred * quant[0]

          // AC
          let k = 1
          while (k < 64) {
            const rs = reader.decodeHuffman(acTable)
            const r = rs >> 4
            const s = rs & 0x0f
            if (s === 0) {
              if (r !== 15) break // EOB
              k += 16
              continue
            }
            k += r
            if (k >= 64) break
            const value = reader.receiveExtend(s)
            coeffs[ZIGZAG[k]] = value * quant[k]
            k++
          }

          idct8x8(coeffs, blkOut, 8, 0)

          const destX = (mcuX * comp.h + bx) * 8
          const destY = (mcuY * comp.v + by) * 8
          for (let y = 0; y < 8; y++) {
            const rowStart = (destY + y) * comp.planeWidth + destX
            for (let x = 0; x < 8; x++) {
              const value = blkOut[y * 8 + x]
              comp.plane[rowStart + x] = value < 0 ? 0 : value > 255 ? 255 : value
            }
          }
        }
      }
    }
    mcu++
  }
  void blocksPerMcu
}

/**
 * 按熵段读取比特流，自动处理 0xFF 填充和 RST marker。
 */
class BitReader {
  constructor(bytes, start, end) {
    this.bytes = bytes
    this.pos = start
    this.end = end
    this.bitBuf = 0
    this.bitCount = 0
  }

  fill() {
    // 最多攒到 24 位：<<8 后是 32 位，再高就会撞上 JS 32 位有符号整数的边界
    while (this.bitCount <= 24) {
      let byte
      if (this.pos >= this.end) {
        byte = 0 // 流末尾补 0，解码器自己会因数据不足而停下
        this.pos++
      } else {
        byte = this.bytes[this.pos]
        if (byte === 0xff) {
          const next = this.pos + 1 < this.end ? this.bytes[this.pos + 1] : -1
          if (next === 0x00) {
            // 字节填充：0xFF 00 表示真正的数据字节 0xFF
            this.pos += 2
          } else {
            // 真正的 marker（RSTn / 下一个段）：当前熵段到此为止
            byte = 0
            this.pos = this.end
          }
        } else {
          this.pos++
        }
      }
      this.bitBuf = ((this.bitBuf << 8) | byte) | 0
      this.bitCount += 8
    }
  }

  getBits(n) {
    if (n === 0) return 0
    this.fill()
    this.bitCount -= n
    const value = (this.bitBuf >>> this.bitCount) & ((1 << n) - 1)
    return value
  }

  decodeHuffman(table) {
    this.fill()
    const peek = (this.bitBuf >>> (this.bitCount - 9)) & 0x1ff
    const entry = table.lookup[peek]
    if (entry >= 0) {
      const len = entry >> 8
      this.bitCount -= len
      return table.values[entry & 0xff]
    }
    // 长码：逐位累积
    let code = 0
    for (let len = 1; len <= 16; len++) {
      code = (code << 1) | this.getBits(1)
      if (table.maxcode[len] >= 0 && code <= table.maxcode[len] && code >= table.mincode[len]) {
        const index = table.valptr[len] + (code - table.mincode[len])
        if (index < table.values.length) return table.values[index]
      }
    }
    throw new Error('invalid Huffman code')
  }

  receiveExtend(t) {
    const value = this.getBits(t)
    if (value < 1 << (t - 1)) return value - (1 << t) + 1
    return value
  }

  restart() {
    this.bitCount = 0
    this.bitBuf = 0
    // 跳到下一个 RSTn
    while (this.pos + 1 < this.end) {
      if (this.bytes[this.pos] === 0xff) {
        const next = this.bytes[this.pos + 1]
        if (next >= 0xd0 && next <= 0xd7) {
          this.pos += 2
          return
        }
      }
      this.pos++
    }
  }
}

/**
 * 各分量 plane → RGBA。
 */
function assemble(frameComponents, width, height, adobeTransform) {
  const out = new Uint8ClampedArray(width * height * 4)
  const count = frameComponents.length

  /** 在分量平面上双线性采样（坐标已归一到 0..1） */
  const sample = (comp, fx, fy) => {
    const pw = comp.planeWidth
    const ph = comp.planeHeight
    const sx = Math.min(pw - 1, Math.max(0, fx))
    const sy = Math.min(ph - 1, Math.max(0, fy))
    const x0 = Math.floor(sx)
    const y0 = Math.floor(sy)
    const x1 = Math.min(pw - 1, x0 + 1)
    const y1 = Math.min(ph - 1, y0 + 1)
    const dx = sx - x0
    const dy = sy - y0
    const p00 = comp.plane[y0 * pw + x0]
    const p10 = comp.plane[y0 * pw + x1]
    const p01 = comp.plane[y1 * pw + x0]
    const p11 = comp.plane[y1 * pw + x1]
    const top = p00 + (p10 - p00) * dx
    const bottom = p01 + (p11 - p01) * dx
    return top + (bottom - top) * dy
  }

  if (count === 1) {
    const y = frameComponents[0]
    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        const v = sample(y, (px * y.planeWidth) / width, (py * y.planeHeight) / height)
        const i = (py * width + px) * 4
        out[i] = v
        out[i + 1] = v
        out[i + 2] = v
        out[i + 3] = 255
      }
    }
    return { width, height, data: out }
  }

  if (count !== 3) {
    // 4 分量（CMYK/YCCK）不常见，取前三通道当 RGB
    const [a, b, c] = frameComponents
    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        const i = (py * width + px) * 4
        out[i] = sample(a, (px * a.planeWidth) / width, (py * a.planeHeight) / height)
        out[i + 1] = sample(b, (px * b.planeWidth) / width, (py * b.planeHeight) / height)
        out[i + 2] = sample(c, (px * c.planeWidth) / width, (py * c.planeHeight) / height)
        out[i + 3] = 255
      }
    }
    return { width, height, data: out }
  }

  // 3 分量：YCbCr 还是 RGB？
  // Adobe APP14 的 transform: 0 = CMYK/RGB, 1 = YCbCr
  // 没有 APP14 时按分量 id 判断：'R','G','B' 是 RGB，其余当 YCbCr
  const [c0, c1, c2] = frameComponents
  const looksRgb = adobeTransform === 0 ||
    (adobeTransform < 0 && c0.id === 0x52 && c1.id === 0x47 && c2.id === 0x42)

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const a = sample(c0, (px * c0.planeWidth) / width, (py * c0.planeHeight) / height)
      const b = sample(c1, (px * c1.planeWidth) / width, (py * c1.planeHeight) / height)
      const c = sample(c2, (px * c2.planeWidth) / width, (py * c2.planeHeight) / height)
      const i = (py * width + px) * 4
      if (looksRgb) {
        out[i] = a
        out[i + 1] = b
        out[i + 2] = c
      } else {
        const Y = a
        const Cb = b - 128
        const Cr = c - 128
        out[i] = clamp8(Y + 1.402 * Cr + 0.5)
        out[i + 1] = clamp8(Y - 0.344136 * Cb - 0.714136 * Cr + 0.5)
        out[i + 2] = clamp8(Y + 1.772 * Cb + 0.5)
      }
      out[i + 3] = 255
    }
  }
  return { width, height, data: out }
}
