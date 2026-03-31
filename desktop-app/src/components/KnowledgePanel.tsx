import { useState, useEffect, useRef } from 'react'
import KnowledgeTree from './KnowledgeTree'
import KnowledgeViewer from './KnowledgeViewer'
import KnowledgeEditor from './KnowledgeEditor'
import { LLMService, ModelConfig } from '../services/llm-service'
import { generateTestCasesFromContent } from '../services/test-generator'

interface Props {
  avatarId: string
  onClose: () => void
  /** GAP6: 知识文件保存后回调，用于刷新 system prompt */
  onSaved?: () => void
  /** GAP9a: OCR 模型配置，用于图片文字识别 */
  ocrModel?: ModelConfig
  /** GAP12: Chat 模型，用于自动生成测试用例 */
  chatModel?: ModelConfig
}

export default function KnowledgePanel({ avatarId, onClose, onSaved, ocrModel, chatModel }: Props) {
  const [tree, setTree] = useState<FileNode[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState<string>('')
  const [editedContent, setEditedContent] = useState<string>('')
  const [isEditMode, setIsEditMode] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [isSearching, setIsSearching] = useState(false)

  // GAP7: 新建文件对话框状态
  const [showNewFileDialog, setShowNewFileDialog] = useState(false)
  const [newFilePath, setNewFilePath] = useState('')
  const [confirmDeletePath, setConfirmDeletePath] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [statusMsg, setStatusMsg] = useState('')

  // GAP9a: 文档导入状态
  const [isImporting, setIsImporting] = useState(false)
  // GAP12: 自动生成测试用例状态
  const [isGeneratingTests, setIsGeneratingTests] = useState(false)
  const newFileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    loadTree()
  }, [avatarId])

  useEffect(() => {
    if (showNewFileDialog) {
      setTimeout(() => newFileInputRef.current?.focus(), 50)
    }
  }, [showNewFileDialog])

  const loadTree = async () => {
    const knowledgeTree = await window.electronAPI.getKnowledgeTree(avatarId)
    setTree(knowledgeTree)
  }

  const handleSelectFile = async (path: string) => {
    setSelectedPath(path)
    setIsEditMode(false)
    setSearchResults([])
    const content = await window.electronAPI.readKnowledgeFile(avatarId, path)
    setFileContent(content)
    setEditedContent(content)
  }

  const showStatus = (msg: string) => {
    setStatusMsg(msg)
    setTimeout(() => setStatusMsg(''), 2500)
  }

  // GAP6: 保存后触发 prompt 刷新
  const handleSave = async () => {
    if (!selectedPath) return
    setIsSaving(true)
    try {
      await window.electronAPI.writeKnowledgeFile(avatarId, selectedPath, editedContent)
      setFileContent(editedContent)
      setIsEditMode(false)
      showStatus('✓ 已保存')
      onSaved?.()
    } catch (error) {
      console.error('保存知识文件失败:', error)
      showStatus('✗ 保存失败')
    } finally {
      setIsSaving(false)
    }
  }

  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      setSearchResults([])
      return
    }
    setIsSearching(true)
    const results = await window.electronAPI.searchKnowledge(avatarId, searchQuery)
    setSearchResults(results)
    setIsSearching(false)
  }

  // GAP7: 创建新文件
  const handleCreateFile = async () => {
    if (!newFilePath.trim()) return
    const filePath = newFilePath.endsWith('.md') ? newFilePath : `${newFilePath}.md`
    try {
      await window.electronAPI.createKnowledgeFile(avatarId, filePath, `# ${filePath.replace(/\.md$/, '').split('/').pop()}\n\n`)
      await loadTree()
      setShowNewFileDialog(false)
      setNewFilePath('')
      handleSelectFile(filePath)
      showStatus('✓ 文件已创建')
    } catch (error) {
      console.error('创建文件失败:', error)
      showStatus('✗ 创建失败')
    }
  }

  // GAP7: 删除文件（使用内联确认替代 confirm()）
  const handleDeleteFile = async (filePath: string) => {
    try {
      await window.electronAPI.deleteKnowledgeFile(avatarId, filePath)
      await loadTree()
      if (selectedPath === filePath) {
        setSelectedPath(null)
        setFileContent('')
        setEditedContent('')
      }
      setConfirmDeletePath(null)
      showStatus('✓ 文件已删除')
    } catch (error) {
      console.error('删除文件失败:', error)
      showStatus('✗ 删除失败')
    }
  }

  /**
   * GAP9a: 导入文档
   * 1. 打开文件选择对话框
   * 2. 调用主进程解析文件（提取文字 + 图片）
   * 3. 对每张图片调用 Qwen OCR（如已配置 ocrModel）
   * 4. 将合并文本保存为新知识文件
   */
  const handleImportDocument = async () => {
    setIsImporting(true)
    try {
      const result = await window.electronAPI.showOpenDialog({
        title: '导入文档',
        filters: [
          { name: '支持的文件', extensions: ['pdf', 'docx', 'doc', 'txt', 'md', 'jpg', 'jpeg', 'png', 'gif', 'webp'] },
          { name: 'PDF 文件', extensions: ['pdf'] },
          { name: 'Word 文档', extensions: ['docx', 'doc'] },
          { name: '图片', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] },
          { name: '文本文件', extensions: ['txt', 'md'] },
        ],
        properties: ['openFile'],
      })
      if (result.canceled || result.filePaths.length === 0) return

      const filePath = result.filePaths[0]
      showStatus('解析文档中...')

      const parsed = await window.electronAPI.parseDocument(filePath)
      const textParts: string[] = []

      if (parsed.text) {
        textParts.push(parsed.text)
      }

      // OCR 图片（需要 ocrModel 配置）
      if (parsed.images.length > 0 && ocrModel?.apiKey) {
        showStatus(`OCR 识别 ${parsed.images.length} 张图片...`)
        const ocr = new LLMService(ocrModel)
        for (const imageDataUrl of parsed.images) {
          try {
            const ocrText = await ocr.complete([
              {
                role: 'user',
                content: [
                  { type: 'image_url', image_url: { url: imageDataUrl } },
                  { type: 'text', text: '请识别图片中的所有文字内容，保持原始格式输出。' },
                ],
              },
            ])
            if (ocrText) textParts.push(`\n---\n${ocrText}`)
          } catch (err) {
            console.error('OCR 失败:', err)
          }
        }
      } else if (parsed.images.length > 0 && !ocrModel?.apiKey) {
        textParts.push(`\n\n> 注意：文档包含 ${parsed.images.length} 张图片，但未配置 OCR 模型，图片内容未识别。请在设置中配置 Qwen API Key。`)
      }

      if (textParts.length === 0) {
        showStatus('✗ 未能提取任何内容')
        return
      }

      // 生成目标知识文件名
      const baseName = parsed.fileName.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_')
      const targetPath = `imports/${baseName}.md`
      const fileContent = `# ${parsed.fileName}\n\n> 导入自: ${parsed.fileName}  \n> 类型: ${parsed.fileType}\n\n---\n\n${textParts.join('\n\n')}`

      await window.electronAPI.writeKnowledgeFile(avatarId, targetPath, fileContent)
      await loadTree()
      handleSelectFile(targetPath)
      showStatus(`✓ 已导入: ${targetPath}`)
      onSaved?.()
    } catch (error) {
      console.error('导入文档失败:', error)
      showStatus('✗ 导入失败')
    } finally {
      setIsImporting(false)
    }
  }

  /**
   * GAP12: 根据当前选中的知识文件自动生成测试用例
   */
  const handleGenerateTests = async () => {
    if (!selectedPath || !fileContent || !chatModel?.apiKey) {
      showStatus('✗ 需要选择文件并配置 Chat API Key')
      return
    }
    setIsGeneratingTests(true)
    showStatus('生成测试用例中...')
    try {
      const fileName = selectedPath.split('/').pop() ?? selectedPath
      const generated = await generateTestCasesFromContent(fileContent, fileName, chatModel)
      if (generated.length === 0) {
        showStatus('✗ 未能生成测试用例，请检查内容')
        return
      }
      for (const tc of generated) {
        await window.electronAPI.createTestCase(avatarId, {
          id: `auto-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          name: tc.name,
          category: tc.category,
          timeout: 30,
          prompt: tc.prompt,
          rubrics: tc.rubrics,
          mustContain: tc.mustContain,
          mustNotContain: [],
        })
      }
      showStatus(`✓ 已生成 ${generated.length} 个测试用例`)
    } catch (err) {
      console.error('生成测试用例失败:', err)
      showStatus('✗ 生成失败')
    } finally {
      setIsGeneratingTests(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-px-black/80 flex items-center justify-center z-50">
      <div className="bg-px-white border-2 border-px-black shadow-[8px_8px_0_0_#0A0A0A] w-[90vw] h-[90vh] flex flex-col">
        {/* 头部 */}
        <div className="flex items-center justify-between px-6 py-4 bg-px-black text-px-white border-b-2 border-px-black">
          <div>
            <h2 className="font-pixel text-sm tracking-wider">KNOWLEDGE BASE</h2>
            {statusMsg && (
              <p className={`font-pixel text-[8px] mt-0.5 ${statusMsg.includes('✓') ? 'text-green-400' : 'text-red-400'}`}>
                {statusMsg}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* GAP9a: 导入文档按钮 */}
            <button
              onClick={handleImportDocument}
              disabled={isImporting}
              className="pixel-btn-outline-light text-[10px] disabled:opacity-40"
              aria-label="导入文档"
            >
              {isImporting ? 'IMPORTING...' : '[↑] IMPORT'}
            </button>
            {/* GAP7: 新建文件按钮 */}
            <button
              onClick={() => setShowNewFileDialog(true)}
              className="pixel-btn-outline-light text-[10px]"
              aria-label="新建文件"
            >
              [+] NEW
            </button>
            <button onClick={onClose} className="pixel-close-btn" aria-label="关闭">X</button>
          </div>
        </div>

        {/* GAP7: 新建文件内联对话框 */}
        {showNewFileDialog && (
          <div className="px-6 py-3 bg-px-warm border-b-2 border-px-border flex items-center gap-3">
            <span className="font-pixel text-[8px] text-px-black tracking-wider">NEW FILE:</span>
            <input
              ref={newFileInputRef}
              type="text"
              value={newFilePath}
              onChange={(e) => setNewFilePath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateFile()
                if (e.key === 'Escape') { setShowNewFileDialog(false); setNewFilePath('') }
              }}
              placeholder="path/to/file.md"
              className="pixel-input flex-1 text-sm py-1.5"
            />
            <button onClick={handleCreateFile} className="pixel-btn-primary text-[10px]">[✓] OK</button>
            <button onClick={() => { setShowNewFileDialog(false); setNewFilePath('') }} className="pixel-btn-ghost text-[10px]">CANCEL</button>
          </div>
        )}

        {/* 搜索栏 */}
        <div className="px-6 py-3 border-b-2 border-px-border">
          <div className="flex gap-2">
            <input
              type="text"
              placeholder="> search knowledge..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              className="pixel-input flex-1"
            />
            <button
              onClick={handleSearch}
              disabled={isSearching}
              className="pixel-btn-secondary disabled:opacity-40"
            >
              {isSearching ? 'SEARCHING...' : '[?] SEARCH'}
            </button>
          </div>
        </div>

        {/* 主体 */}
        <div className="flex-1 flex overflow-hidden">
          {/* 左侧：文件树 */}
          <div className="w-64 border-r-2 border-px-border overflow-y-auto bg-px-warm">
            <KnowledgeTree
              tree={tree}
              onSelectFile={handleSelectFile}
              selectedPath={selectedPath}
              confirmDeletePath={confirmDeletePath}
              onRequestDelete={(path) => setConfirmDeletePath(path)}
              onConfirmDelete={handleDeleteFile}
              onCancelDelete={() => setConfirmDeletePath(null)}
            />
          </div>

          {/* 右侧：内容区域 */}
          <div className="flex-1 flex flex-col overflow-hidden">
            {searchResults.length > 0 ? (
              <div className="flex-1 overflow-y-auto p-6">
                <h3 className="font-pixel text-xs text-px-black tracking-wider mb-4">
                  RESULTS ({searchResults.length})
                </h3>
                {searchResults.map((result, index) => (
                  <div key={index} className="mb-4 p-4 border-2 border-px-border bg-px-warm">
                    <button
                      onClick={() => { handleSelectFile(result.path); setSearchResults([]) }}
                      className="font-mono text-sm font-medium text-px-black hover:underline mb-2 block"
                    >
                      {result.path}
                    </button>
                    <div className="font-mono text-xs text-px-muted space-y-1">
                      {result.matches.map((match, i) => (
                        <div key={i}>{match}</div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : selectedPath ? (
              <>
                <div className="flex items-center justify-between px-4 py-2 border-b-2 border-px-border bg-px-warm">
                  <span className="font-mono text-sm text-px-muted">{selectedPath}</span>
                  <div className="flex gap-2 items-center">
                    {isSaving && <span className="font-pixel text-[8px] text-px-muted">SAVING...</span>}
                    {isEditMode ? (
                      <>
                        <button onClick={() => setIsEditMode(false)} className="pixel-btn-ghost text-[10px]">PREVIEW</button>
                        <button onClick={handleSave} disabled={isSaving} className="pixel-btn-primary text-[10px] disabled:opacity-40">
                          [✓] SAVE
                        </button>
                      </>
                    ) : (
                      <>
                        {/* GAP12: 自动生成测试用例按钮 */}
                        {chatModel?.apiKey && (
                          <button
                            onClick={handleGenerateTests}
                            disabled={isGeneratingTests}
                            className="pixel-btn-outline text-[10px] disabled:opacity-40"
                            title="根据此文件生成测试用例"
                          >
                            {isGeneratingTests ? 'GEN...' : '[T] GEN TESTS'}
                          </button>
                        )}
                        <button onClick={() => setIsEditMode(true)} className="pixel-btn-secondary text-[10px]">[/] EDIT</button>
                      </>
                    )}
                  </div>
                </div>
                <div className="flex-1 overflow-hidden">
                  {isEditMode ? (
                    <KnowledgeEditor
                      content={editedContent}
                      onChange={(value) => setEditedContent(value || '')}
                      onSave={handleSave}
                    />
                  ) : (
                    <KnowledgeViewer content={fileContent} />
                  )}
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center">
                <p className="font-pixel text-[10px] text-px-muted tracking-wider">SELECT A FILE</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
