import Editor from '@monaco-editor/react'

interface Props {
  content: string
  onChange: (value: string | undefined) => void
  onSave: () => void
}

export default function KnowledgeEditor({ content, onChange, onSave }: Props) {
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-4 py-2 bg-gray-100 border-b">
        <span className="text-sm text-gray-600">编辑模式</span>
        <button
          onClick={onSave}
          className="px-4 py-1 bg-blue-600 text-white text-sm rounded hover:bg-blue-700"
        >
          保存 (Ctrl+S)
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
            wordWrap: 'on',
            lineNumbers: 'on',
            scrollBeyondLastLine: false,
          }}
          onMount={(editor) => {
            // 添加保存快捷键
            editor.addCommand(
              // Ctrl+S / Cmd+S
              window.navigator.platform.match('Mac') ? 2097 : 2048 + 49,
              onSave
            )
          }}
        />
      </div>
    </div>
  )
}
