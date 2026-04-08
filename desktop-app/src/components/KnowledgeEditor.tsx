import Editor from '@monaco-editor/react'

interface Props {
  content: string
  onChange: (value: string | undefined) => void
  onSave: () => void
}

export default function KnowledgeEditor({ content, onChange, onSave }: Props) {
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-4 py-2 bg-px-elevated border-b-2 border-px-border">
        <span className="font-game text-[12px] text-px-text-sec tracking-wider">编辑模式</span>
        <button
          onClick={onSave}
          className="pixel-btn-primary py-1"
        >
          保存
        </button>
      </div>
      <div className="flex-1">
        <Editor
          height="100%"
          defaultLanguage="markdown"
          value={content}
          onChange={onChange}
          theme="vs-dark"
          options={{
            minimap: { enabled: false },
            fontSize: 14,
            fontFamily: '"JetBrains Mono", "Courier New", monospace',
            wordWrap: 'on',
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
            renderLineHighlight: 'all',
            lineHeight: 24,
          }}
          onMount={(editor) => {
            editor.addCommand(
              window.navigator.platform.match('Mac') ? 2097 : 2048 + 49,
              onSave
            )
          }}
        />
      </div>
    </div>
  )
}
