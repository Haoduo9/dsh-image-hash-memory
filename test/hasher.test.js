/**
 * test/hasher.test.js — 感知哈希与双门禁的单元测试。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'

import {
  computeDhash,
  computeAhash,
  computePhash,
  computeImageFingerprint,
  hammingDistance,
  similarityScore,
  passesCompositeGate,
  setImageDecoder,
  bitsToHex,
  hexToBits,
} from '../lib/hasher.js'
import { decodePng } from '../lib/png.js'

/** 造一张有结构的内存图 */
export function makeImage(w, h, painter) {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a = 255] = painter(x, y)
      const i = (y * w + x) * 4
      data[i] = r
      data[i + 1] = g
      data[i + 2] = b
      data[i + 3] = a
    }
  }
  return { width: w, height: h, data }
}

/** 一张有矩形、圆、斜线的图（跟 Python 版测试用例同构图） */
export function baseImage() {
  return makeImage(300, 300, (x, y) => {
    if (x > 25 && x < 120 && y > 25 && y < 120) return [30, 80, 200]
    if ((x - 180) ** 2 + (y - 180) ** 2 < 80 ** 2) return [220, 60, 60]
    if (Math.abs(x - y) < 6) return [40, 190, 40]
    return [245, 245, 245]
  })
}

/** 完全不同的图：黑白竖条纹 */
export function otherImage() {
  return makeImage(300, 300, (x) => (Math.floor(x / 20) % 2 === 0 ? [20, 20, 20] : [250, 250, 250]))
}

/** 同构图 + 整体提亮 6 个灰阶 */
export function nearImage() {
  const base = baseImage()
  const data = new Uint8ClampedArray(base.data)
  for (let i = 0; i < data.length; i++) {
    if (i % 4 === 3) continue
    data[i] = Math.min(255, data[i] + 6)
  }
  return { width: 300, height: 300, data }
}

test('同样的图算出同样的哈希', () => {
  const a = baseImage()
  const b = baseImage()
  assert.equal(computeDhash(a), computeDhash(b))
  assert.equal(computeAhash(a), computeAhash(b))
  assert.equal(computePhash(a), computePhash(b))
  assert.equal(hammingDistance(computeDhash(a), computeDhash(b)), 0)
})

test('哈希是 16 位小写 hex', () => {
  const img = baseImage()
  for (const hash of [computeDhash(img), computeAhash(img), computePhash(img)]) {
    assert.match(hash, /^[0-9a-f]{16}$/)
  }
})

test('轻微提亮的图仍是近邻', () => {
  const a = baseImage()
  const b = nearImage()
  assert.ok(hammingDistance(computeDhash(a), computeDhash(b)) <= 8, 'dHash 应判为近邻')
  assert.ok(hammingDistance(computePhash(a), computePhash(b)) <= 8, 'pHash 应判为近邻')
})

test('结构不同的图必须拉开距离', () => {
  const a = baseImage()
  const b = otherImage()
  assert.ok(hammingDistance(computeDhash(a), computeDhash(b)) > 24, 'dHash 距离应超过默认阈值')
  assert.ok(hammingDistance(computePhash(a), computePhash(b)) > 12, 'pHash 距离应超过默认阈值')
})

test('汉明距离与相似度', () => {
  assert.equal(hammingDistance('0000000000000000', '0000000000000000'), 0)
  assert.equal(hammingDistance('0000000000000000', '000000000000000f'), 4)
  assert.equal(hammingDistance('0000000000000000', 'ffffffffffffffff'), 64)
  assert.equal(similarityScore('0000000000000000', '000000000000000f'), 1 - 4 / 64)
  assert.throws(() => hammingDistance('zzzz', '0000'))
})

test('综合双门禁：两道都过才放行', () => {
  const q = { dhash: '0000000000000000', phash: '0000000000000000' }
  // dHash 过、pHash 不过 → 拦
  assert.equal(passesCompositeGate(q, { dhash: '0000000000000000', phash: 'ffffffffffffffff' }), false)
  // 两道都过 → 放
  assert.equal(passesCompositeGate(q, { dhash: '0000000000000003', phash: '0000000000000003' }), true)
  // dHash 不过 → 拦，哪怕 pHash 一样
  assert.equal(
    passesCompositeGate(q, { dhash: 'ffffffff00000000', phash: '0000000000000000' }),
    false,
  )
  // 不开双门禁时只看 dHash
  assert.equal(
    passesCompositeGate(q, { dhash: '0000000000000000', phash: 'ffffffffffffffff' }, { requireBoth: false }),
    true,
  )
})

test('位与 hex 互转', () => {
  const bits = Array.from({ length: 64 }, (_, i) => i % 3 === 0)
  const hex = bitsToHex(bits)
  assert.match(hex, /^[0-9a-f]{16}$/)
  assert.equal(hexToBits(hex), BigInt(`0x${hex}`))
})

test('只有注册了解码器才能算指纹', async () => {
  setImageDecoder(null)
  await assert.rejects(() => computeImageFingerprint(new Uint8Array([1, 2, 3])))
})

test('解码真实 PNG：与 PIL 参考一致', async () => {
  const path = new URL('./fixtures/rgb.png', import.meta.url)
  if (!existsSync(path)) return // 没有 fixture 就跳过
  const bytes = new Uint8Array(readFileSync(path))
  const img = await decodePng(bytes)
  assert.equal(img.width, 400)
  assert.equal(img.height, 300)
  // 左上角应该是背景色 (245,245,245)
  assert.deepEqual(Array.from(img.data.slice(0, 4)), [245, 245, 245, 255])
})

test('PNG 的 RGB / 调色板 / RGBA 三种编码解出同一张图', async () => {
  const load = async (name) => {
    const path = new URL(`./fixtures/${name}`, import.meta.url)
    if (!existsSync(path)) return null
    return decodePng(new Uint8Array(readFileSync(path)))
  }
  const rgb = await load('rgb.png')
  const rgba = await load('rgba.png')
  const palette = await load('palette.png')
  if (rgb === null || rgba === null || palette === null) return
  const dh = computeDhash(rgb)
  assert.equal(computeDhash(rgba), dh)
  assert.equal(computeDhash(palette), dh)
  assert.equal(computePhash(rgba), computePhash(rgb))
  assert.equal(computePhash(palette), computePhash(rgb))
})
