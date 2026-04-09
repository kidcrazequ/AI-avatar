import { useState, useEffect, useRef } from 'react'
import KnowledgeTree from './KnowledgeTree'
import KnowledgeViewer from './KnowledgeViewer'
import KnowledgeEditor from './KnowledgeEditor'
import { LLMService, ModelConfig } from '../services/llm-service'
import { cleanOcrHtml, cleanPdfFullText, detectFabricatedNumbers, stripDocxToc, mergeVisionIntoText, formatDocument } from '@soul/core'
import type { LLMCallFn } from '@soul/core'
import { generateTestCasesFromContent } from '../services/test-generator'
import Modal from './shared/Modal'
import PanelHeader from './shared/PanelHeader'

interface Props {
  avatarId: string
  onClose: () => void
  onSaved?: () => void
  ocrModel?: ModelConfig
  chatModel?: ModelConfig
  creationModel?: ModelConfig
}

export default function KnowledgePanel({ avatarId, onClose, onSaved, ocrModel, chatModel, creationModel }: Props) {
  const [tree, setTree] = useState<FileNode[]>([])
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState<string>('')
  const [editedContent, setEditedContent] = useState<string>('')
  const [isEditMode, setIsEditMode] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [isSearching, setIsSearching] = useState(false)

  const [showNewFileDialog, setShowNewFileDialog] = useState(false)
  const [newFilePath, setNewFilePath] = useState('')
  const [confirmDeletePath, setConfirmDeletePath] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [statusMsg, setStatusMsg] = useState('')

  const [isImporting, setIsImporting] = useState(false)
  const [isGeneratingTests, setIsGeneratingTests] = useState(false)
  const [isCompiling, setIsCompiling] = useState(false)
  const [isLinting, setIsLinting] = useState(false)
  const [isDetectingEvolution, setIsDetectingEvolution] = useState(false)
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

  const showStatus = (msg: string, autoClear = true) => {
    setStatusMsg(msg)
    if (autoClear) {
      setTimeout(() => setStatusMsg(''), 2500)
    }
  }

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

  const handleImportDocument = async () => {
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

      setIsImporting(true)
      const filePath = result.filePaths[0]

      // 保留原始文件到 knowledge/_raw/（Karpathy 融合：source of truth 不丢失）
      try {
        await window.electronAPI.preserveRawFile(avatarId, filePath)
      } catch (rawErr) {
        console.warn('原始文件保留失败（不影响导入）:', rawErr)
      }

      showStatus('解析文档中...', false)

      const parsed = await window.electronAPI.parseDocument(filePath)

      let rawText = parsed.text || ''

      const visionResults: string[] = []
      if (parsed.images.length > 0 && ocrModel?.apiKey) {
        const visionConfig: ModelConfig = {
          ...ocrModel,
          model: 'qwen-vl-max',
        }
        const vision = new LLMService(visionConfig)
        const visionPrompt = '请仔细分析这张技术文档页面图片，提取所有有价值的结构化信息：' +
          '1. 尺寸图/工程图：提取所有尺寸标注数值（单位mm），整理为参数表格；' +
          '2. 设备布局图：描述各组件的空间位置关系，整理为布局表格；' +
          '3. 原理图/流程图：描述流向、各部件名称和功能；' +
          '4. 数据表格：以 Markdown 表格格式输出；' +
          '5. 接线图：描述端子排列、线缆规格。' +
          '输出要求：使用 Markdown 格式，直接输出内容不要用代码围栏包裹，保留原始精度数值，' +
          '只输出图片中实际可见的数据，不要编造或推断图片中不存在的数值，' +
          '禁止使用任何 emoji 图标，不要在末尾附加总结或自评。'

        for (let i = 0; i < parsed.images.length; i++) {
          showStatus(`图纸解读 ${i + 1} / ${parsed.images.length}...`, false)
          try {
            const visionText = await vision.complete([
              {
                role: 'user',
                content: [
                  { type: 'image_url', image_url: { url: parsed.images[i] } },
                  { type: 'text', text: visionPrompt },
                ],
              },
            ])
            if (visionText) {
              const cleaned = cleanOcrHtml(visionText)
              visionResults.push(cleaned)
            }
          } catch (err) {
            console.error('Vision 分析失败:', err)
          }
        }
      } else if (parsed.images.length > 0 && !ocrModel?.apiKey) {
        rawText += `\n\n> 注意：文档包含 ${parsed.images.length} 张图表页，但未配置 Qwen API Key，图片内容未识别。请在设置中配置。`
      }

      if (!rawText && visionResults.length === 0) {
        showStatus('✗ 未能提取任何内容')
        return
      }

      let cleanedText = cleanPdfFullText(rawText)
      if (parsed.fileType === 'word') {
        cleanedText = stripDocxToc(cleanedText)
      }

      if (visionResults.length > 0 && parsed.perPageChars) {
        const visionForMerge = visionResults.map((content, i) => ({
          pageNum: parsed.imagePageNumbers?.[i] ?? (i + 1),
          content,
        }))
        cleanedText = mergeVisionIntoText(cleanedText, visionForMerge, parsed.perPageChars)
      }

      const baseModel = creationModel?.apiKey ? creationModel : chatModel
      let finalContent: string

      if (baseModel?.apiKey && cleanedText.length > 500) {
        showStatus('LLM 逐章格式化中...', false)

        const restructureModel: ModelConfig = { ...baseModel, model: 'qwen-plus' }
        const llm = new LLMService(restructureModel)

        const callLLM: LLMCallFn = async (systemPrompt, userPrompt, maxTokens = 8192) => {
          return llm.complete([
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ], { maxTokens })
        }

        try {
          finalContent = await formatDocument(
            cleanedText,
            parsed.fileName.replace(/\.[^.]+$/, ''),
            parsed.fileName,
            callLLM,
            (progress) => {
              showStatus(`格式化章节 ${progress.current}/${progress.total}：${progress.chapterTitle}`, false)
            },
          )

          const visionAllText = visionResults.join('\n')
          const fabricated = detectFabricatedNumbers(finalContent, rawText + '\n' + visionAllText)
          if (fabricated.length > 0) {
            console.warn(`数值校验警告：发现 ${fabricated.length} 个疑似编造数值：${fabricated.join(', ')}`)
          }
        } catch (err) {
          console.error('LLM 逐章格式化失败，使用原始文本:', err)
          finalContent = `# ${parsed.fileName}\n\n> 导入自: ${parsed.fileName}\n\n---\n\n${cleanedText}`
        }
      } else {
        finalContent = `# ${parsed.fileName}\n\n> 导入自: ${parsed.fileName}\n> 类型: ${parsed.fileType}\n\n---\n\n${cleanedText}`
      }

      const baseName = parsed.fileName.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_')
      const targetPath = `${baseName}.md`

      await window.electronAPI.writeKnowledgeFile(avatarId, targetPath, finalContent)

      try {
        let existingReadme = ''
        try {
          existingReadme = await window.electronAPI.readKnowledgeFile(avatarId, 'README.md')
        } catch {
          // README 不存在
        }

        const fileEntry = `| \`${targetPath}\` | ${parsed.fileName} | 导入自 ${parsed.fileType.toUpperCase()} 文件 |`

        if (existingReadme && existingReadme.includes('_(暂无，待添加)_')) {
          const updatedReadme = existingReadme.replace(
            '| _(暂无，待添加)_ | | |',
            fileEntry
          )
          await window.electronAPI.writeKnowledgeFile(avatarId, 'README.md', updatedReadme)
        } else if (existingReadme && !existingReadme.includes(targetPath)) {
          const tableEndPattern = /(\| .+ \| .+ \| .+ \|)\n\n## 图片/
          const match = existingReadme.match(tableEndPattern)
          if (match) {
            const updatedReadme = existingReadme.replace(
              tableEndPattern,
              `$1\n${fileEntry}\n\n## 图片`
            )
            await window.electronAPI.writeKnowledgeFile(avatarId, 'README.md', updatedReadme)
          }
        }
      } catch (readmeErr) {
        console.warn('README.md 回填失败（不影响导入）:', readmeErr)
      }

      // 构建检索索引（上下文摘要 + 向量嵌入），提升 RAG 检索质量
      const indexApiKey = ocrModel?.apiKey || baseModel?.apiKey
      const indexBaseUrl = ocrModel?.baseUrl || baseModel?.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
      if (indexApiKey) {
        try {
          showStatus('构建检索索引（上下文摘要 + 向量嵌入）...', false)
          const indexResult = await window.electronAPI.buildKnowledgeIndex(avatarId, indexApiKey, indexBaseUrl)
          console.log(`检索索引构建完成：${indexResult.contextCount} 上下文，${indexResult.embeddingCount} 向量`)
        } catch (indexErr) {
          console.warn('检索索引构建失败（不影响导入）:', indexErr)
        }
      }

      // Phase 2: 知识演化检测（导入后自动检测与已有知识的差异）
      const evolutionModel = creationModel?.apiKey ? creationModel : chatModel
      if (evolutionModel?.apiKey && finalContent.length > 200) {
        try {
          setIsDetectingEvolution(true)
          showStatus('知识演化检测中...', false)
          const evoBaseUrl = evolutionModel.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
          const evoReport = await window.electronAPI.detectEvolution(
            avatarId, finalContent, parsed.fileName, evolutionModel.apiKey, evoBaseUrl,
          )
          if (evoReport.diffs.length > 0) {
            const newCount = evoReport.diffs.filter(d => d.type === 'new').length
            const updateCount = evoReport.diffs.filter(d => d.type === 'updated').length
            const conflictCount = evoReport.diffs.filter(d => d.type === 'contradiction').length
            showStatus(
              `✓ 已导入: ${targetPath} | 演化检测：${newCount} 新增，${updateCount} 更新，${conflictCount} 矛盾`,
            )
          } else {
            showStatus(`✓ 已导入: ${targetPath} | 无知识演化差异`)
          }
        } catch (evoErr) {
          console.warn('知识演化检测失败（不影响导入）:', evoErr)
          showStatus(`✓ 已导入: ${targetPath}`)
        } finally {
          setIsDetectingEvolution(false)
        }
      } else {
        showStatus(`✓ 已导入: ${targetPath}`)
      }

      await loadTree()
      handleSelectFile(targetPath)
      onSaved?.()
    } catch (error) {
      console.error('导入文档失败:', error)
      showStatus('✗ 导入失败')
    } finally {
      setIsImporting(false)
    }
  }

  const handleGenerateTests = async () => {
    const testModel = creationModel?.apiKey ? creationModel : chatModel
    if (!selectedPath || !fileContent || !testModel?.apiKey) {
      showStatus('✗ 需要选择文件并配置 API Key')
      return
    }
    setIsGeneratingTests(true)
    showStatus(`生成测试用例中（${testModel.model}）...`, false)
    try {
      const fileName = selectedPath.split('/').pop() ?? selectedPath
      const generated = await generateTestCasesFromContent(fileContent, fileName, testModel)
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
          mustNotContain: tc.mustNotContain,
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

  /**
   * 编译知识百科：提取实体 → 生成概念聚合页。
   * 结果保存在 avatar/wiki/concepts/，不影响现有知识库和回答。
   */
  const handleCompileWiki = async () => {
    const model = creationModel?.apiKey ? creationModel : chatModel
    if (!model?.apiKey) {
      showStatus('✗ 需要配置 API Key')
      return
    }
    setIsCompiling(true)
    showStatus('编译知识百科中（实体提取 + 概念页生成）...', false)
    try {
      const baseUrl = model.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
      const result = await window.electronAPI.compileWiki(avatarId, model.apiKey, baseUrl)
      showStatus(`✓ 百科编译完成：${result.entityCount} 个实体，${result.conceptPageCount} 个概念页`)
    } catch (err) {
      console.error('百科编译失败:', err)
      showStatus('✗ 百科编译失败')
    } finally {
      setIsCompiling(false)
    }
  }

  /**
   * 知识自检（Lint）：检测知识文件间的矛盾和重复。
   * 结果保存在 avatar/wiki/lint-report.json，不修改任何知识文件。
   */
  const handleLintKnowledge = async () => {
    const model = creationModel?.apiKey ? creationModel : chatModel
    if (!model?.apiKey) {
      showStatus('✗ 需要配置 API Key')
      return
    }
    setIsLinting(true)
    showStatus('知识自检中（矛盾检测 + 重复检测）...', false)
    try {
      const baseUrl = model.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
      const report = await window.electronAPI.lintKnowledge(avatarId, model.apiKey, baseUrl)
      if (report.issueCount === 0) {
        showStatus(`✓ 自检通过：${report.totalFiles} 个文件，${report.totalChunks} 个片段，未发现问题`)
      } else {
        showStatus(`⚠ 发现 ${report.issueCount} 个问题（${report.issues.filter(i => i.type === 'contradiction').length} 矛盾，${report.issues.filter(i => i.type === 'duplicate').length} 重复）`)
      }
    } catch (err) {
      console.error('知识自检失败:', err)
      showStatus('✗ 自检失败')
    } finally {
      setIsLinting(false)
    }
  }

  return (
    <Modal isOpen={true} onClose={onClose} size="lg">
      <PanelHeader
        title="KNOWLEDGE BASE"
        subtitle={statusMsg || undefined}
        onClose={onClose}
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={handleImportDocument}
              disabled={isImporting}
              className="pixel-btn-outline-light disabled:opacity-40"
              aria-label="导入文档"
            >
              {isImporting ? '...' : 'IMPORT'}
            </button>
            <button
              onClick={() => setShowNewFileDialog(true)}
              className="pixel-btn-outline-light"
              aria-label="新建文件"
            >
              [+] NEW
            </button>
            <button
              onClick={handleCompileWiki}
              disabled={isCompiling}
              className="pixel-btn-outline-light disabled:opacity-40"
              aria-label="编译百科"
              title="提取实体、生成概念聚合页（不影响现有回答）"
            >
              {isCompiling ? '...' : 'WIKI'}
            </button>
            <button
              onClick={handleLintKnowledge}
              disabled={isLinting}
              className="pixel-btn-outline-light disabled:opacity-40"
              aria-label="知识自检"
              title="检测知识文件间的矛盾和重复（不修改任何文件）"
            >
              {isLinting ? '...' : 'LINT'}
            </button>
          </div>
        }
      />

      {/* 新建文件内联对话框 */}
      {showNewFileDialog && (
        <div className="px-6 py-3 bg-px-elevated border-b-2 border-px-border flex items-center gap-3">
          <span className="font-game text-[12px] text-px-primary tracking-wider">新建:</span>
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
          <button onClick={handleCreateFile} className="pixel-btn-primary py-1.5">OK</button>
          <button onClick={() => { setShowNewFileDialog(false); setNewFilePath('') }} className="pixel-btn-ghost py-1.5">CANCEL</button>
        </div>
      )}

      {/* 导入进度条 */}
      {(isImporting || isDetectingEvolution) && statusMsg && (
        <div className="px-6 py-3 border-b-2 border-px-primary/30 bg-px-primary/5">
          <div className="flex items-center gap-3">
            <div className="w-4 h-4 border-2 border-px-primary border-t-transparent rounded-full animate-spin" />
            <span className="font-game text-[13px] text-px-primary tracking-wider">{statusMsg}</span>
          </div>
        </div>
      )}

      {/* 搜索栏 */}
      <div className="px-6 py-3 border-b-2 border-px-border bg-px-surface">
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="搜索知识..."
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
            {isSearching ? '...' : 'SEARCH'}
          </button>
        </div>
      </div>

      {/* 主体 */}
      <div className="flex-1 flex overflow-hidden">
        {/* 左侧：文件树 */}
        <div className="w-60 border-r-2 border-px-border overflow-y-auto bg-px-bg">
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
            <div className="flex-1 overflow-y-auto p-6 bg-px-surface">
              <h3 className="font-game text-[13px] text-px-text tracking-wider mb-4">
                搜索结果 ({searchResults.length})
              </h3>
              {searchResults.map((result, index) => (
                <div key={index} className="mb-4 p-4 border-2 border-px-border bg-px-elevated">
                  <button
                    onClick={() => { handleSelectFile(result.path); setSearchResults([]) }}
                    className="font-game text-[14px] font-medium text-px-primary hover:underline mb-2 block"
                  >
                    {result.path}
                  </button>
                  <div className="font-game text-[13px] text-px-text-sec space-y-1">
                    {result.matches.map((match, i) => (
                      <div key={i}>{match}</div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : selectedPath ? (
            <>
              <div className="flex items-center justify-between px-4 py-2 border-b-2 border-px-border bg-px-elevated">
                <span className="font-game text-[13px] text-px-text-sec">{selectedPath}</span>
                <div className="flex gap-2 items-center">
                  {isSaving && <span className="font-game text-[12px] text-px-text-dim tracking-wider">保存中...</span>}
                  {isEditMode ? (
                    <>
                      <button onClick={() => setIsEditMode(false)} className="pixel-btn-ghost py-1">PREVIEW</button>
                      <button onClick={handleSave} disabled={isSaving} className="pixel-btn-primary py-1">
                        SAVE
                      </button>
                    </>
                  ) : (
                    <>
                      {chatModel?.apiKey && (
                        <button
                          onClick={handleGenerateTests}
                          disabled={isGeneratingTests}
                          className="pixel-btn-outline-muted py-1"
                          title="根据此文件生成测试用例"
                        >
                          {isGeneratingTests ? '...' : 'GEN TEST'}
                        </button>
                      )}
                      <button onClick={() => setIsEditMode(true)} className="pixel-btn-outline-light py-1">EDIT</button>
                    </>
                  )}
                </div>
              </div>
              <div className="flex-1 overflow-hidden bg-px-surface">
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
            <div className="flex-1 flex items-center justify-center bg-px-surface">
              <div className="text-center">
                <div className="w-12 h-12 border-2 border-px-border bg-px-elevated flex items-center justify-center mx-auto mb-3">
                  <svg className="w-5 h-5 text-px-text-dim" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="square" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                  </svg>
                </div>
                <p className="font-game text-[12px] text-px-text-dim tracking-wider">选择一个文件</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
