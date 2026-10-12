/**
 * deck_stage starter component.
 *
 * @author zhi.qu
 * @date 2026-04-28
 */

class DeckStage extends HTMLElement {
  connectedCallback() {
    this.innerHTML = '<slot></slot>'
  }
}

if (!customElements.get('deck-stage')) {
  customElements.define('deck-stage', DeckStage)
}

