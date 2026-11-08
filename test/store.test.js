/**
 * test/store.test.js — 存储层单元测试（内存库）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ImageMemoryStore } from '../lib/store.js'

function fresh() {
  return new ImageMemoryStore(':memory:')
}

const FP_A = { attachmentId: 'sha256:aaa', dhash: '4040483838383803', phash: 'a91c9c6bf3671d9e' }
const FP_B = { attachmentId: 'sha256:bbb', dhash: '4040483838383803', phash: 'a91c9c6bf3671d9e' }
const FP_NEAR = { attachmentId: 'sha256:near', dhash: '4040483838383802', phash: 'a91c9c6bf3671d9f' }
const FP_FAR = { attachmentId: 'sha256:far', dhash: 'ffffffff00000000', phash: '00000000ffffffff' }

test('新图入库后能查到', () => {
  const store = fresh()
  try {
    const { row, created } = store.record({ ...FP_A, userText: '这是啥' })
    assert.equal(created, true)
    assert.equal(row.id, 1)
    assert.equal(store.count(), 1)
    assert.equal(store.getByAttachment('sha256:aaa').id, 1)
  } finally {
    store.close()
  }
})

test('同一个 attachmentId 再传一次只累加次数', () => {
  const store = fresh()
  try {
    store.record(FP_A)
    const second = store.record(FP_A)
    assert.equal(second.created, false)
    assert.equal(store.count(), 1)
    assert.equal(second.row.hit_count, 2)
  } finally {
    store.close()
  }
})

test('不同 attachmentId 但图很像：并入已有记录', () => {
  const store = fresh()
  try {
    store.record(FP_A)
    const near = store.record({ ...FP_NEAR, summary: '换个文件名重传' })
    assert.equal(near.created, false)
    assert.equal(store.count(), 1)
    assert.ok(near.row.summary.includes('换个文件名重传'))
  } finally {
    store.close()
  }
})

test('完全不同的图另起一条', () => {
  const store = fresh()
  try {
    store.record(FP_A)
    const far = store.record(FP_FAR)
    assert.equal(far.created, true)
    assert.equal(store.count(), 2)
  } finally {
    store.close()
  }
})

test('相似检索按距离排序且只返回门禁内的', () => {
  const store = fresh()
  try {
    store.record(FP_A)
    store.record(FP_FAR)
    const hits = store.findSimilar({ dhash: FP_A.dhash, phash: FP_A.phash })
    assert.equal(hits.length, 1)
    assert.equal(hits[0].dhash_distance, 0)
    assert.equal(hits[0].phash_distance, 0)
    assert.ok(hits[0].similarity > 0.9)
  } finally {
    store.close()
  }
})

test('关键词搜索与最近列表', () => {
  const store = fresh()
  try {
    store.record({ ...FP_A, userText: '一张蓝色的截图' })
    store.record({ ...FP_FAR, summary: '纯条纹图' })
    assert.equal(store.search('蓝色').length, 1)
    assert.equal(store.search('不存在的词').length, 0)
    assert.equal(store.recent(10).length, 2)
  } finally {
    store.close()
  }
})

test('删除与统计', () => {
  const store = fresh()
  try {
    const { row } = store.record({ ...FP_A, summary: '有摘要' })
    store.record(FP_FAR)
    const stats = store.stats()
    assert.equal(stats.total, 2)
    assert.equal(stats.withSummary, 1)
    assert.equal(store.deleteById(row.id), true)
    assert.equal(store.deleteById(row.id), false)
    assert.equal(store.count(), 1)
  } finally {
    store.close()
  }
})

test('关掉双门禁后只看 dHash', () => {
  const store = fresh()
  try {
    // 同 dHash 但 pHash 差很远
    store.record({ attachmentId: 'sha256:x', dhash: '4040483838383803', phash: 'ffffffffffffffff' })
    const strict = store.findSimilar(
      { dhash: '4040483838383803', phash: '0000000000000000' },
      { requireBoth: true },
    )
    const loose = store.findSimilar(
      { dhash: '4040483838383803', phash: '0000000000000000' },
      { requireBoth: false },
    )
    assert.equal(strict.length, 0)
    assert.equal(loose.length, 1)
  } finally {
    store.close()
  }
})
