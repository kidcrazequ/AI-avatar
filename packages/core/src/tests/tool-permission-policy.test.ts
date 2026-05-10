/**
 * @author zhi.qu
 * @date 2026-05-09
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  evaluateConversationModeToolPolicy,
  evaluateProxyTrustGreyDenial,
  shouldConfirmGreyZoneOnDesktop,
} from '../tool-permission-policy'

describe('tool-permission-policy', () => {
  it('plan mode blocks write_file but allows switch_mode', () => {
    assert.equal(evaluateConversationModeToolPolicy('plan', 'write_file').denied, true)
    assert.equal(evaluateConversationModeToolPolicy('plan', 'switch_mode').denied, false)
    assert.equal(evaluateConversationModeToolPolicy('plan', 'read_file').denied, false)
  })

  it('ask mode blocks read_file', () => {
    const r = evaluateConversationModeToolPolicy('ask', 'read_file')
    assert.equal(r.denied, true)
    if (r.denied) assert.match(r.message, /Ask/)
  })

  it('proxy denies grey call_mcp_tool', () => {
    const r = evaluateProxyTrustGreyDenial('proxy', 'call_mcp_tool')
    assert.equal(r.denied, true)
  })

  it('ui allows call_mcp_tool until dialog layer', () => {
    assert.equal(evaluateProxyTrustGreyDenial('ui', 'call_mcp_tool').denied, false)
  })

  it('shouldConfirmGreyZoneOnDesktop for exec_shell', () => {
    assert.equal(shouldConfirmGreyZoneOnDesktop('exec_shell'), true)
    assert.equal(shouldConfirmGreyZoneOnDesktop('switch_mode'), false)
  })
})
