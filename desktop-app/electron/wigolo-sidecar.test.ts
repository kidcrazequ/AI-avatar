/**
 * WigoloSidecar 单测（wigolo 边车生命周期，docs/wigolo-cn-search-plan.md 子任务 1）。
 *
 * 全部依赖走注入的 fake（spawnImpl / healthCheckImpl / resolveBinaryImpl），
 * 不真 spawn、不真联网。验证点：
 *   1. 端口上已有健康 daemon → 复用（不 spawn），stop 不动外部 daemon
 *   2. 二进制未安装 → not-installed + 安装指引（不 spawn、不自动下载）
 *   3. spawn 成功（健康检查先 false 后 true）→ ready + baseUrl；再次 ensureReady 幂等不重复 spawn
 *   4. spawn 后进程立即退出 → failed 且 detail 含 stderr 尾部
 *   5. 并发 ensureReady 共享同一 promise，只 spawn 一次
 *   6. stop 只 SIGTERM 自己 spawn 的进程；stop 后可重新 ensureReady
 */

import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WigoloSidecar, type WigoloSidecarOptions } from './wigolo-sidecar'

type SpawnImpl = NonNullable<WigoloSidecarOptions['spawnImpl']>

/** 最小可用的 ChildProcess 仿制品：只实现 sidecar 用到的表面 */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  exitCode: number | null = null
  signalCode: string | null = null
  killSignals: Array<string | number | undefined> = []

  kill(signal?: string | number): boolean {
    this.killSignals.push(signal)
    return true
  }
}

interface SpawnCall {
  cmd: string
  args: string[]
}

/** 记录调用参数并返回固定 FakeChild 的 spawn 仿制品 */
function makeFakeSpawn(child: FakeChild, calls: SpawnCall[]): SpawnImpl {
  return ((cmd: string, args: string[]) => {
    calls.push({ cmd, args })
    return child
  }) as unknown as SpawnImpl
}

/** 按队列顺序出结果的健康检查仿制品，队列耗尽后固定返回 fallback */
function makeHealthQueue(results: boolean[], fallback: boolean) {
  return async () => (results.length > 0 ? results.shift()! : fallback)
}

test('WigoloSidecar: 端口上已有健康 daemon 时直接复用，不 spawn；stop 不动外部 daemon', async () => {
  const calls: SpawnCall[] = []
  const child = new FakeChild()
  let resolveCalled = 0
  const sidecar = new WigoloSidecar({
    port: 4444,
    healthCheckImpl: async () => true,
    resolveBinaryImpl: () => {
      resolveCalled++
      return '/usr/local/bin/wigolo'
    },
    spawnImpl: makeFakeSpawn(child, calls),
  })

  const status = await sidecar.ensureReady()
  assert.equal(status.state, 'ready')
  assert.equal(status.baseUrl, 'http://127.0.0.1:4444', 'baseUrl 应指向配置的端口')
  assert.equal(calls.length, 0, '复用外部 daemon 时不应 spawn')
  assert.equal(resolveCalled, 0, '健康 daemon 在位时不应走到二进制定位')

  await sidecar.stop()
  assert.equal(child.killSignals.length, 0, '复用的外部 daemon 绝不能被 kill')
  assert.equal(sidecar.getStatus().state, 'stopped')
})

test('WigoloSidecar: 二进制未安装 → not-installed + 安装指引，不 spawn', async () => {
  const calls: SpawnCall[] = []
  const sidecar = new WigoloSidecar({
    healthCheckImpl: async () => false,
    resolveBinaryImpl: () => null,
    spawnImpl: makeFakeSpawn(new FakeChild(), calls),
  })

  const status = await sidecar.ensureReady()
  assert.equal(status.state, 'not-installed')
  assert.ok(status.detail?.includes('npx wigolo init --no-warmup'), 'detail 应含安装命令')
  assert.ok(status.detail?.includes('wigolo warmup --all'), 'detail 应含 warmup 指引')
  assert.equal(calls.length, 0, '未安装时不应 spawn（更不许自动下载）')
})

test('WigoloSidecar: spawn 成功（健康检查先 false 后 true）→ ready；再次调用幂等', async () => {
  const calls: SpawnCall[] = []
  const child = new FakeChild()
  const sidecar = new WigoloSidecar({
    // 第 1 次 = 复用探测 false；第 2 次 = spawn 后首轮 false；之后 true
    healthCheckImpl: makeHealthQueue([false, false], true),
    resolveBinaryImpl: () => '/usr/local/bin/wigolo',
    spawnImpl: makeFakeSpawn(child, calls),
  })

  const status = await sidecar.ensureReady()
  assert.equal(status.state, 'ready')
  assert.equal(status.baseUrl, 'http://127.0.0.1:3333', '默认端口 3333')
  assert.equal(calls.length, 1, '应恰好 spawn 一次')
  assert.equal(calls[0].cmd, '/usr/local/bin/wigolo')
  assert.equal(calls[0].args[0], 'serve', '应以 serve 子命令启动')

  // 幂等：已 ready 且进程存活，再次调用不重复 spawn
  const again = await sidecar.ensureReady()
  assert.equal(again.state, 'ready')
  assert.equal(calls.length, 1, '重复 ensureReady 不得再 spawn')
})

test('WigoloSidecar: spawn 后进程立即退出 → failed 且 detail 含 stderr 尾部', async () => {
  const calls: SpawnCall[] = []
  const child = new FakeChild()
  const fakeSpawn = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args })
    // 等 sidecar 挂好监听后再报错退出（模拟端口占用类启动即死）
    setImmediate(() => {
      child.stderr.emit('data', 'Error: listen EADDRINUSE 127.0.0.1:3333')
      child.exitCode = 1
      child.emit('exit', 1, null)
    })
    return child
  }) as unknown as SpawnImpl

  const sidecar = new WigoloSidecar({
    healthCheckImpl: async () => false,
    resolveBinaryImpl: () => '/usr/local/bin/wigolo',
    spawnImpl: fakeSpawn,
  })

  const status = await sidecar.ensureReady()
  assert.equal(status.state, 'failed')
  assert.ok(status.detail?.includes('EADDRINUSE'), 'detail 应带出 stderr 尾部供诊断')
  assert.ok(status.detail?.includes('进程提前退出'), 'detail 应说明退出原因')
  assert.equal(sidecar.getStatus().state, 'failed', 'getStatus 应与返回值一致')
})

test('WigoloSidecar: 并发 ensureReady 共享同一 promise，只 spawn 一次', async () => {
  const calls: SpawnCall[] = []
  const child = new FakeChild()
  const sidecar = new WigoloSidecar({
    // 第 1 次 = 复用探测 false；spawn 后首轮即 true
    healthCheckImpl: makeHealthQueue([false], true),
    resolveBinaryImpl: () => '/usr/local/bin/wigolo',
    spawnImpl: makeFakeSpawn(child, calls),
  })

  const [a, b] = await Promise.all([sidecar.ensureReady(), sidecar.ensureReady()])
  assert.equal(a.state, 'ready')
  assert.equal(b.state, 'ready')
  assert.equal(calls.length, 1, '并发调用必须只 spawn 一次')
})

test('WigoloSidecar: stop 只 SIGTERM 自己 spawn 的进程；stop 后可重新 ensureReady', async () => {
  const calls: SpawnCall[] = []
  const child = new FakeChild()
  const sidecar = new WigoloSidecar({
    // 启动一次：探测 false → spawn 后 true；stop 后重启：探测 true（复用路径）
    healthCheckImpl: makeHealthQueue([false], true),
    resolveBinaryImpl: () => '/usr/local/bin/wigolo',
    spawnImpl: makeFakeSpawn(child, calls),
  })

  const status = await sidecar.ensureReady()
  assert.equal(status.state, 'ready')
  assert.equal(calls.length, 1)

  await sidecar.stop()
  assert.deepEqual(child.killSignals, ['SIGTERM'], '自己 spawn 的进程应被 SIGTERM 回收')
  assert.equal(sidecar.getStatus().state, 'stopped')

  // stop 后可重启：此时端口上健康检查为 true（走复用分支），不再 spawn
  const restarted = await sidecar.ensureReady()
  assert.equal(restarted.state, 'ready')
  assert.equal(calls.length, 1, '本轮走复用分支，不新增 spawn')
  assert.equal(child.killSignals.length, 1, '不应重复 kill')
})
