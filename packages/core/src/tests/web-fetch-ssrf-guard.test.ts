/**
 * web_fetch SSRF 防护：isPrivateIp 应拦下所有非 global-unicast 段。
 *
 * 回归点（之前漏拦，启用联网后 LLM 可借 web_fetch 打到这些地址）：
 *   - CGNAT / Tailscale 100.64.0.0/10
 *   - benchmarking 198.18.0.0/15、IETF 192.0.0.0/24、TEST-NET、6to4 relay
 *   - 多播 224/4、保留 240/4、广播 255.255.255.255
 *   - IPv6 全部 special-use（::、::1、fc00::/7、fe80::/10、ff00::/8、NAT64、6to4、Teredo、文档）
 *   - IPv4-mapped IPv6 按内嵌 IPv4 判（::ffff:10.0.0.1 拦、::ffff:8.8.8.8 放行）
 * 同时确保公网地址不被误杀（边界附近的下一个/上一个地址）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isPrivateIp, resolveAndAssertNotPrivate } from '../tool-router'

const BLOCKED = [
  // IPv4 special-use
  '0.0.0.0', '10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255',
  '192.168.1.1', '100.64.0.1', '100.127.255.255', '198.18.0.1', '198.19.255.255',
  '192.0.0.1', '192.0.2.5', '192.88.99.1', '198.51.100.5', '203.0.113.5',
  '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255',
  // IPv6 special-use
  '::', '::1', 'fe80::1', 'febf:ffff::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
  '2001:db8::1', '2002:c0a8:0101::1', '64:ff9b::808:808', '2001::1',
  // 2000::/3 内 Globally Reachable=false 段（IANA registry，之前漏放行）
  '2001:2::1', '2001:2:0:ffff::1', '2001:10::1', '3fff::1', '3fff:0fff:ffff::1', '5f00::1',
  // 2001::/23（IETF Protocol Assignments）父段默认 GR=false：未分配/非 allowlist 子段也要拦
  '2001:5::1', '2001:100::1', '2001:1ff:ffff::1', '2001:1::4',
  // IPv4-mapped → 内嵌私网
  '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:169.254.0.1',
]

const ALLOWED = [
  // 公网 IPv4，含各拦截段的紧邻边界外地址
  '8.8.8.8', '1.1.1.1', '11.0.0.1', '126.255.255.255', '128.0.0.1',
  '100.63.255.255', '100.128.0.0', '172.15.255.255', '172.32.0.0',
  '198.17.255.255', '198.20.0.0', '223.255.255.255', '9.9.9.9',
  // 公网 IPv6 + mapped 公网
  '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8',
  // 2001::/23 内 Globally Reachable=true 的更具体段（不能被父段默认拦误杀）
  '2001:20::1',          // ORCHIDv2（GR=true，区别于已废弃的 2001:10::/28）
  '2001:30::1',          // Drone Remote ID DET（GR=true）
  '2001:3::1',           // AMT（GR=true）
  '2001:4:112::1',       // AS112-v6（GR=true）
  '2001:1::1', '2001:1::2', '2001:1::3',  // PCP / TURN / DNS-SD Anycast（GR=true）
]

// 非 IP 字符串：契约是返回 false（由调用方按 hostname 黑名单单独处理 localhost 等）
const NON_IP = ['localhost', 'example.com', 'not-an-ip', '']

test('isPrivateIp 拦下所有 special-use / 非公网段', () => {
  for (const ip of BLOCKED) {
    assert.equal(isPrivateIp(ip), true, `应拦截：${ip}`)
  }
})

test('isPrivateIp 放行公网 global-unicast（含边界外地址，不误杀）', () => {
  for (const ip of ALLOWED) {
    assert.equal(isPrivateIp(ip), false, `应放行：${ip}`)
  }
})

test('isPrivateIp 对非 IP 字符串返回 false（保留原契约）', () => {
  for (const s of NON_IP) {
    assert.equal(isPrivateIp(s), false, `非 IP 应返回 false：${JSON.stringify(s)}`)
  }
})

// resolveAndAssertNotPrivate 是 web_fetch 实际用的 SSRF 网关。IPv6 literal URL
// （http://[2606:...]/）的 URL.hostname 带 []，需先剥方括号再按 IP 直判（不走 DNS）。
test('resolveAndAssertNotPrivate 放行带方括号的公网 IPv6 literal', async () => {
  const r = await resolveAndAssertNotPrivate('[2606:4700:4700::1111]')
  assert.equal(r.address, '2606:4700:4700::1111')
  assert.equal(r.family, 6)
})

test('resolveAndAssertNotPrivate 拒绝带方括号的内网/回环 IPv6 literal', async () => {
  await assert.rejects(() => resolveAndAssertNotPrivate('[::1]'))
  await assert.rejects(() => resolveAndAssertNotPrivate('[fc00::1]'))
  await assert.rejects(() => resolveAndAssertNotPrivate('[::ffff:10.0.0.1]'))
})

test('resolveAndAssertNotPrivate 裸 IPv6（无方括号）仍直判', async () => {
  const r = await resolveAndAssertNotPrivate('2606:4700:4700::1111')
  assert.equal(r.family, 6)
  await assert.rejects(() => resolveAndAssertNotPrivate('fe80::1'))
})
