/**
 * hasher.js — 纯 JS 感知哈希器（无原生依赖）。
 *
 * 移植自 Python 版 image-hash-memory（Hermes Agent）的 hasher.py：
 *   - dHash  64 bit：8x9 灰度梯度差（抗裁剪 / 比例变化）
 *   - aHash  64 bit：8x8 灰度均值（快，抗轻微缩放）
 *   - pHash  64 bit：32x32 → 2D DCT 低频 8x8（抗滤镜 / 调色 / 对比度偏移）
 *
 * 图片解码本身依赖宿主注入的解码器（见 setImageDecoder），因为 DSH 的图片
 * 走 attachments 服务，插件不应该自带一套重型图像库。
 */

/** @typedef {{ width: number, height: number, data: Uint8ClampedArray }} RgbaImage */

const HASH_SIZE = 8
/** pHash 先缩到 32x32 再做 DCT（8 * highfreqFactor） */
const PHASH_SIZE = 32
const HIGHR_FREQ_FACTOR = 4

// ---------------------------------------------------------------------------
// 解码器注入
// ---------------------------------------------------------------------------

/** @type {((bytes: Uint8Array, mediaType?: string) => Promise<RgbaImage>) | null} */
let decoder = null

/**
 * 注册全局图片解码器。插件启动时注入一个基于宿主服务（attachments）的实现。
 * @param {(bytes: Uint8Array, mediaType?: string) => Promise<RgbaImage>} fn
 */
export function setImageDecoder(fn) {
  decoder = fn
}

/**
 * 一个零依赖的兜底解码器工厂：用 Node 内置能力无法解 PNG/JPEG，所以这里
 * 只提供「调用方自己贴像素」的入口，供测试和外部桥使用。
 * @param {RgbaImage} image
 * @returns {() => Promise<RgbaImage>}
 */
export function staticDecoder(image) {
  return async () => image
}

// ---------------------------------------------------------------------------
// 缩放 / 灰度
// ---------------------------------------------------------------------------

/**
 * 面积平均缩放（box filter），比最近邻更能保住 pHash 需要的低频能量。
 * @param {RgbaImage} src
 * @param {number} dw
 * @param {number} dh
 * @returns {Float64Array} 灰度平面 dw*dh
 */
export function resizeGray(src, dw, dh) {
  const { width: sw, height: sh, data } = src
  const out = new Float64Array(dw * dh)
  const xRatio = sw / dw
  const yRatio = sh / dh

  for (let y = 0; y < dh; y++) {
    const y0 = Math.floor(y * yRatio)
    const y1 = Math.min(sh, Math.max(y0 + 1, Math.floor((y + 1) * yRatio)))
    for (let x = 0; x < dw; x++) {
      const x0 = Math.floor(x * xRatio)
      const x1 = Math.min(sw, Math.max(x0 + 1, Math.floor((x + 1) * xRatio)))
      let sum = 0
      let count = 0
      for (let sy = y0; sy < y1; sy++) {
        const rowBase = sy * sw
        for (let sx = x0; sx < x1; sx++) {
          const i = (rowBase + sx) * 4
          // Rec.601 亮度权重，与 Python 版 Pillow 的 "L" 模式一致
          sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
          count++
        }
      }
      out[y * dw + x] = count > 0 ? sum / count : 0
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// 哈希计算
// ---------------------------------------------------------------------------

/**
 * 位数组 → 16 位小写 hex
 * @param {boolean[]} bits
 * @returns {string}
 */
export function bitsToHex(bits) {
  if (bits.length !== 64) throw new Error(`expected 64 bits, got ${bits.length}`)
  let out = ''
  for (let i = 0; i < 64; i += 4) {
    let nibble = 0
    for (let j = 0; j < 4; j++) nibble = (nibble << 1) | (bits[i + j] ? 1 : 0)
    out += nibble.toString(16)
  }
  return out
}

/**
 * 16 位 hex → 64 位 BigInt
 * @param {string} hex
 * @returns {bigint}
 */
export function hexToBits(hex) {
  if (typeof hex !== 'string') throw new TypeError('hash must be a string')
  const clean = hex.trim().toLowerCase()
  if (!/^[0-9a-f]{16}$/.test(clean)) throw new Error(`invalid 64-bit hex hash: ${hex}`)
  return BigInt(`0x${clean}`)
}

/**
 * @param {RgbaImage} image
 * @returns {string} 16 位 hex
 */
export function computeDhash(image) {
  // 9 列 x 8 行：每行 8 个相邻差值
  const gray = resizeGray(image, HASH_SIZE + 1, HASH_SIZE)
  const bits = []
  for (let y = 0; y < HASH_SIZE; y++) {
    for (let x = 0; x < HASH_SIZE; x++) {
      const left = gray[y * (HASH_SIZE + 1) + x]
      const right = gray[y * (HASH_SIZE + 1) + x + 1]
      bits.push(left > right)
    }
  }
  return bitsToHex(bits)
}

/**
 * @param {RgbaImage} image
 * @returns {string} 16 位 hex
 */
export function computeAhash(image) {
  const gray = resizeGray(image, HASH_SIZE, HASH_SIZE)
  let total = 0
  for (let i = 0; i < gray.length; i++) total += gray[i]
  const mean = total / gray.length
  const bits = new Array(gray.length)
  for (let i = 0; i < gray.length; i++) bits[i] = gray[i] > mean
  return bitsToHex(bits)
}

/**
 * 一维 DCT-II 的余弦基矩阵（缓存）。
 * @param {number} n
 * @returns {Float64Array[]}
 */
const cosineCache = new Map()
function cosineMatrix(n) {
  const cached = cosineCache.get(n)
  if (cached !== undefined) return cached
  const rows = []
  for (let u = 0; u < n; u++) {
    const row = new Float64Array(n)
    const scale = u === 0 ? Math.sqrt(1 / n) : Math.sqrt(2 / n)
    for (let x = 0; x < n; x++) row[x] = scale * Math.cos(((2 * x + 1) * u * Math.PI) / (2 * n))
    rows.push(row)
  }
  cosineCache.set(n, rows)
  return rows
}

/**
 * 2D DCT-II，返回 n*n 系数矩阵（行主序）。
 * @param {Float64Array} src 长度 n*n
 * @param {number} n
 * @returns {Float64Array}
 */
export function dct2d(src, n) {
  const C = cosineMatrix(n)
  const tmp = new Float64Array(n * n)
  // 行变换：tmp[v][y] = sum_x C[v][x] * src[y][x]
  for (let y = 0; y < n; y++) {
    for (let v = 0; v < n; v++) {
      const row = C[v]
      let sum = 0
      for (let x = 0; x < n; x++) sum += row[x] * src[y * n + x]
      tmp[y * n + v] = sum
    }
  }
  // 列变换：out[u][v] = sum_y C[u][y] * tmp[y][v]
  const out = new Float64Array(n * n)
  for (let u = 0; u < n; u++) {
    const row = C[u]
    for (let v = 0; v < n; v++) {
      let sum = 0
      for (let y = 0; y < n; y++) sum += row[y] * tmp[y * n + v]
      out[u * n + v] = sum
    }
  }
  return out
}

/**
 * @param {RgbaImage} image
 * @returns {string} 16 位 hex
 */
export function computePhash(image) {
  const size = HASH_SIZE * HIGHR_FREQ_FACTOR // 32
  const gray = resizeGray(image, size, size)
  const dct = dct2d(gray, size)

  // 取左上 8x8 低频块，跳过 DC 项求均值
  const low = []
  let sum = 0
  let count = 0
  for (let u = 0; u < HASH_SIZE; u++) {
    for (let v = 0; v < HASH_SIZE; v++) {
      const val = dct[u * size + v]
      low.push(val)
      if (!(u === 0 && v === 0)) {
        sum += val
        count++
      }
    }
  }
  const mean = count > 0 ? sum / count : 0
  return bitsToHex(low.map((v) => v > mean))
}

/**
 * 一次性算出三件套指纹。
 * @param {Uint8Array} bytes 原始图片字节
 * @param {string} [mediaType]
 * @returns {Promise<{ dhash: string, ahash: string, phash: string, width: number, height: number, filesize: number } | null>}
 */
export async function computeImageFingerprint(bytes, mediaType) {
  if (decoder === null) throw new Error('image decoder 未注册：必须先调用 setImageDecoder()')
  let image
  try {
    image = await decoder(bytes, mediaType)
  } catch {
    return null
  }
  if (image === null || typeof image !== 'object') return null
  const { width, height } = image
  if (!(width > 0) || !(height > 0)) return null
  return {
    dhash: computeDhash(image),
    ahash: computeAhash(image),
    phash: computePhash(image),
    width,
    height,
    filesize: bytes.byteLength,
  }
}

// ---------------------------------------------------------------------------
// 距离 / 门禁
// ---------------------------------------------------------------------------

/**
 * 汉明距离：两个 16 位 hex 的 64 位上不同的个数。
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function hammingDistance(a, b) {
  let diff = hexToBits(a) ^ hexToBits(b)
  let distance = 0
  while (diff > 0n) {
    distance += Number(diff & 1n)
    diff >>= 1n
  }
  return distance
}

/**
 * 0..1 相似度（1 = 完全相同）。
 * @param {string} a
 * @param {string} b
 * @param {number} [totalBits]
 * @returns {number}
 */
export function similarityScore(a, b, totalBits = 64) {
  if (!(totalBits > 0)) throw new Error('totalBits must be positive')
  const score = 1 - hammingDistance(a, b) / totalBits
  return Math.max(0, Math.min(1, score))
}

/**
 * 综合双门禁校验：dHash 与 pHash 必须同时通过。
 * 与 Python 版 verification_mode: composite 行为一致 —— 单纯 dHash 容易把
 * 「构图相同、颜色被极端调过」的图误判为同一张，pHash 兜第二道。
 *
 * @param {{ dhash: string, phash?: string | null }} query
 * @param {{ dhash: string, phash?: string | null }} candidate
 * @param {{ threshold?: number, phashThreshold?: number, requireBoth?: boolean }} [options]
 * @returns {boolean}
 */
export function passesCompositeGate(query, candidate, options = {}) {
  const threshold = options.threshold ?? 24
  const phashThreshold = options.phashThreshold ?? 12
  const requireBoth = options.requireBoth ?? true

  if (hammingDistance(query.dhash, candidate.dhash) > threshold) return false
  if (!requireBoth) return true
  if (!query.phash || !candidate.phash) return true
  return hammingDistance(query.phash, candidate.phash) <= phashThreshold
}

/**
 * 给一对哈希算出完整比较结果，供存储层和工具输出使用。
 * @param {{ dhash: string, phash?: string | null }} query
 * @param {{ dhash: string, phash?: string | null }} candidate
 */
export function compareHashes(query, candidate) {
  const dhashDistance = hammingDistance(query.dhash, candidate.dhash)
  const phashDistance = query.phash && candidate.phash ? hammingDistance(query.phash, candidate.phash) : null
  return {
    dhashDistance,
    phashDistance,
    similarity: 1 - dhashDistance / 64,
  }
}
