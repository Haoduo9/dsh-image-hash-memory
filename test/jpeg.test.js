/**
 * test/jpeg.test.js — JPEG 解码器单元测试。
 *
 * 参考值来自 PIL/libjpeg：同一张图先存 PNG（无损基准），再存各种 JPEG 变体，
 * 比较解出的哈希距离——这才是插件真正关心的指标。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'

import { decodeJpeg } from '../lib/jpeg.js'
import { decodePng } from '../lib/png.js'
import { decodeImage, sniffFormat } from '../lib/image.js'
import { computeDhash, computePhash, hammingDistance, computeImageFingerprint, setImageDecoder } from '../lib/hasher.js'

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url)
const load = (name) => new Uint8Array(readFileSync(fixture(name)))
const has = (name) => existsSync(fixture(name))

/** 每个通道允许的最大误差（色度上采样方式不同带来的差异） */
const MAX_CHANNEL_DIFF = 64
/** 与参考解码器的平均误差上限 */
const MAX_MEAN_DIFF = 8

test('解出正确的尺寸', () => {
  const img = decodeJpeg(load('sample.jpg'))
  assert.equal(img.width, 400)
  assert.equal(img.height, 300)
  assert.equal(img.data.length, 400 * 300 * 4)
})

test('背景色解对（左上角是 245 灰）', () => {
  const img = decodeJpeg(load('sample.jpg'))
  for (const [x, y] of [[0, 0], [5, 5], [390, 290]]) {
    const i = (y * 400 + x) * 4
    for (let c = 0; c < 3; c++) {
      assert.ok(
        Math.abs(img.data[i + c] - 245) <= 4,
        `(${x},${y}) 通道 ${c} = ${img.data[i + c]}，期望约 245`,
      )
    }
  }
})

test('纯色区域内部没有块效应', () => {
  const img = decodeJpeg(load('sample.jpg'))
  // 左上角 20x20 是纯背景，取均值与极差
  let min = 255
  let max = 0
  for (let y = 0; y < 20; y++) {
    for (let x = 0; x < 20; x++) {
      const v = img.data[(y * 400 + x) * 4]
      min = Math.min(min, v)
      max = Math.max(max, v)
    }
  }
  assert.ok(max - min <= 6, `纯色区域极差 ${max - min} 太大`)
})

test('灰度 JPEG 解出 R=G=B', () => {
  const img = decodeJpeg(load('gray.jpg'))
  for (let i = 0; i < img.data.length; i += 4 * 97) {
    assert.equal(img.data[i], img.data[i + 1])
    assert.equal(img.data[i + 1], img.data[i + 2])
  }
})

test('色度采样 4:2:0 与 4:4:4 解出的哈希接近', () => {
  const a = decodeJpeg(load('sample420.jpg'))
  const b = decodeJpeg(load('sample444.jpg'))
  assert.ok(hammingDistance(computeDhash(a), computeDhash(b)) <= 8)
  assert.ok(hammingDistance(computePhash(a), computePhash(b)) <= 8)
})

test('JPEG 与同一张图的 PNG 基准哈希接近', async () => {
  if (!has('rgb.png')) return
  const png = await decodePng(load('rgb.png'))
  const jpeg = decodeJpeg(load('sample.jpg'))
  const dd = hammingDistance(computeDhash(png), computeDhash(jpeg))
  const pd = hammingDistance(computePhash(png), computePhash(jpeg))
  assert.ok(dd <= 16, `dHash 距离 ${dd} 过大`)
  assert.ok(pd <= 16, `pHash 距离 ${pd} 过大`)
})

test('解出来的像素与参考值误差可控', () => {
  // 这几个点是 PIL/libjpeg 解出来的值
  const img = decodeJpeg(load('sample.jpg'))
  const expectations = [
    [50, 50, [30, 81, 199]],
    [200, 150, [34, 191, 42]],
    [300, 100, [245, 245, 245]],
  ]
  let total = 0
  let count = 0
  for (const [x, y, expected] of expectations) {
    const i = (y * 400 + x) * 4
    for (let c = 0; c < 3; c++) {
      const diff = Math.abs(img.data[i + c] - expected[c])
      assert.ok(diff <= MAX_CHANNEL_DIFF, `(${x},${y}) 通道 ${c} 差 ${diff}`)
      total += diff
      count++
    }
  }
  assert.ok(total / count <= MAX_MEAN_DIFF, `平均误差 ${(total / count).toFixed(2)} 过大`)
})

test('渐进式 JPEG 明确报错而不是静默出错数据', () => {
  // 造一个最小渐进式帧头：FFD8 + FFC2 段
  const bytes = new Uint8Array([
    0xff, 0xd8,
    0xff, 0xc2, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x10, 0x03,
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
    0xff, 0xd9,
  ])
  assert.throws(() => decodeJpeg(bytes), /progressive|sequential/i)
})

test('非 JPEG 数据被拒绝', () => {
  assert.throws(() => decodeJpeg(new Uint8Array([1, 2, 3, 4])), /not a JPEG/)
})

test('格式嗅探按魔数认 png / jpeg / webp / gif', () => {
  assert.equal(sniffFormat(load('rgb.png')), 'png')
  assert.equal(sniffFormat(load('sample.jpg')), 'jpeg')
  // 造最小的 RIFF....WEBP 与 GIF 头
  assert.equal(sniffFormat(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])), 'webp')
  assert.equal(sniffFormat(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])), 'gif')
  assert.equal(sniffFormat(new Uint8Array([0, 1, 2, 3])), 'unknown')
})

test('decodeImage 自动分发', async () => {
  const png = await decodeImage(load('rgb.png'))
  assert.equal(png.width, 400)
  const jpeg = await decodeImage(load('sample.jpg'))
  assert.equal(jpeg.width, 400)
  await assert.rejects(() => decodeImage(new Uint8Array([0, 1, 2, 3])), /unsupported/)
})

test('指纹流程端到端：JPEG 走完整链路', async () => {
  setImageDecoder(decodeImage)
  const fp = await computeImageFingerprint(load('sample.jpg'), 'image/jpeg')
  assert.ok(fp !== null)
  assert.match(fp.dhash, /^[0-9a-f]{16}$/)
  assert.match(fp.phash, /^[0-9a-f]{16}$/)
  assert.equal(fp.width, 400)
  assert.equal(fp.height, 300)
})
