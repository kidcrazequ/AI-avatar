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

  it('plan mode blocks Palace writes but allows Palace reads', () => {
    assert.equal(evaluateConversationModeToolPolicy('plan', 'add_palace_commitment').denied, true)
    assert.equal(evaluateConversationModeToolPolicy('plan', 'update_palace_commitment').denied, true)
    assert.equal(evaluateConversationModeToolPolicy('plan', 'add_palace_inbox_item').denied, true)
    assert.equal(evaluateConversationModeToolPolicy('plan', 'update_palace_inbox_item').denied, true)
    assert.equal(evaluateConversationModeToolPolicy('plan', 'list_palace_commitments').denied, false)
    assert.equal(evaluateConversationModeToolPolicy('plan', 'list_palace_inbox').denied, false)
    assert.equal(evaluateConversationModeToolPolicy('plan', 'build_palace_context_card').denied, false)
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

  it('proxy denies Palace writes but allows Palace reads', () => {
    assert.equal(evaluateProxyTrustGreyDenial('proxy', 'add_palace_commitment').denied, true)
    assert.equal(evaluateProxyTrustGreyDenial('proxy', 'update_palace_commitment').denied, true)
    assert.equal(evaluateProxyTrustGreyDenial('proxy', 'list_palace_commitments').denied, false)
  })

  it('ui allows call_mcp_tool until dialog layer', () => {
    assert.equal(evaluateProxyTrustGreyDenial('ui', 'call_mcp_tool').denied, false)
  })

  it('shouldConfirmGreyZoneOnDesktop for exec_shell', () => {
    assert.equal(shouldConfirmGreyZoneOnDesktop('exec_shell'), true)
    assert.equal(shouldConfirmGreyZoneOnDesktop('switch_mode'), false)
  })

  it('shouldConfirmGreyZoneOnDesktop for Palace writes', () => {
    assert.equal(shouldConfirmGreyZoneOnDesktop('add_palace_commitment'), true)
    assert.equal(shouldConfirmGreyZoneOnDesktop('update_palace_commitment'), true)
    assert.equal(shouldConfirmGreyZoneOnDesktop('list_palace_commitments'), false)
    assert.equal(shouldConfirmGreyZoneOnDesktop('add_palace_inbox_item'), false)
    assert.equal(shouldConfirmGreyZoneOnDesktop('update_palace_inbox_item'), false)
  })
})
