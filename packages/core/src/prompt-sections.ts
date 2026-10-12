export const DYNAMIC_SYSTEM_PROMPT_MARKER = '<!-- DYNAMIC_SYSTEM_PROMPT_START -->'

export interface SystemPromptSections {
  stableSystemPrompt: string
  dynamicSystemPrompt: string
  systemPrompt: string
}

function trimOuterWhitespace(text: string | undefined): string {
  return (text ?? '').trim()
}

export function combineSystemPromptSections(
  stableSystemPrompt: string,
  dynamicSystemPrompt?: string,
): string {
  const stable = trimOuterWhitespace(stableSystemPrompt)
  const dynamic = trimOuterWhitespace(dynamicSystemPrompt)
  if (!dynamic) return stable
  if (!stable) return dynamic
  return `${stable}\n\n${DYNAMIC_SYSTEM_PROMPT_MARKER}\n\n${dynamic}`
}

export function splitSystemPromptSections(systemPrompt: string): SystemPromptSections {
  const prompt = trimOuterWhitespace(systemPrompt)
  if (!prompt.includes(DYNAMIC_SYSTEM_PROMPT_MARKER)) {
    return {
      stableSystemPrompt: prompt,
      dynamicSystemPrompt: '',
      systemPrompt: prompt,
    }
  }

  const [stablePart, ...rest] = prompt.split(DYNAMIC_SYSTEM_PROMPT_MARKER)
  const stableSystemPrompt = trimOuterWhitespace(stablePart)
  const dynamicSystemPrompt = trimOuterWhitespace(rest.join(DYNAMIC_SYSTEM_PROMPT_MARKER))

  return {
    stableSystemPrompt,
    dynamicSystemPrompt,
    systemPrompt: combineSystemPromptSections(stableSystemPrompt, dynamicSystemPrompt),
  }
}

export function normalizeSystemPromptSections(
  value: string | Partial<SystemPromptSections>,
): SystemPromptSections {
  if (typeof value === 'string') {
    return splitSystemPromptSections(value)
  }

  const stableSystemPrompt = trimOuterWhitespace(value.stableSystemPrompt ?? '')
  const dynamicSystemPrompt = trimOuterWhitespace(value.dynamicSystemPrompt ?? '')
  const systemPrompt = trimOuterWhitespace(value.systemPrompt ?? combineSystemPromptSections(stableSystemPrompt, dynamicSystemPrompt))

  if (!stableSystemPrompt && systemPrompt) {
    return splitSystemPromptSections(systemPrompt)
  }

  return {
    stableSystemPrompt,
    dynamicSystemPrompt,
    systemPrompt: systemPrompt || combineSystemPromptSections(stableSystemPrompt, dynamicSystemPrompt),
  }
}
