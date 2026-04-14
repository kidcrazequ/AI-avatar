import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import KnowledgeTree from './KnowledgeTree'
import KnowledgeViewer from './KnowledgeViewer'
import KnowledgeEditor from './KnowledgeEditor'
import { LLMService, ModelConfig } from '../services/llm-service'
import { cleanOcrHtml, cleanPdfFullText, detectFabricatedNumbers, stripDocxToc, mergeVisionIntoText, formatDocument, type LLMCallFn } from '@soul/core'
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
  const [isBatchImporting, setIsBatchImporting] = useState(false)
  const [isEnhancing, setIsEnhancing] = useState(false)
  const [enhanceProgress, setEnhanceProgress] = useState<{ current: number; total: number; fileName: string; phase: string } | null>(null)
  const [isGeneratingTests, setIsGeneratingTests] = useState(false)
  const [isCompiling, setIsCompiling] = useState(false)
  const [isLinting, setIsLinting] = useState(false)
  const [isDetectingEvolution, setIsDetectingEvolution] = useState(false)
  /** 导入进度：current/total 用于进度条百分比，phase 用于文本描述 */
  const [importProgress, setImportProgress] = useState<{ current: number; total: number; phase: string } | null>(null)
  /** 批量导入结果抽屉（成功/跳过/失败明细） */
  const [batchResult, setBatchResult] = useState<BatchImportResult | null>(null)
  const [showBatchLog, setShowBatchLog] = useState(false)
  /** 异步任务开始时间，用于显示已用时间 */
  const [taskStartTime, setTaskStartTime] = useState<number | null>(null)
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const newFileInputRef = useRef<HTMLInputElement>(null)
  const statusTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined)
  const fileSelectSeqRef = useRef(0)
  /** 组件挂载状态，防止卸载后的异步操作触发 setState */
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearTimeout(statusTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!taskStartTime) { setElapsedSeconds(0); return }
    const timer = setInterval(() => {
      setElapsedSeconds(Math.floor((Date.now() - taskStartTime) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [taskStartTime])

  // 订阅主进程批量导入进度事件
  useEffect(() => {
    const unsub = window.electronAPI.onImportProgress((data) => {
      if (!mountedRef.current) return
      setImportProgress({
        current: data.current,
        total: data.total,
        phase: `${data.phase} · ${data.fileName}`,
      })
    })
    return () => unsub()
  }, [])

  // 订阅知识库增强进度事件
  useEffect(() => {
    const unsub = window.electronAPI.onEnhanceProgress((data) => {
      if (!mountedRef.current) return
      setEnhanceProgress(data)
    })
    return () => unsub()
  }, [])

  const isBusy = isImporting || isBatchImporting || isEnhancing || isDetectingEvolution || isCompiling || isLinting
  useEffect(() => {
    if (isBusy && !taskStartTime) setTaskStartTime(Date.now())
    if (!isBusy && taskStartTime) setTaskStartTime(null)
  }, [isBusy, taskStartTime])

  const elapsedDisplay = useMemo(() => {
    if (elapsedSeconds < 60) return `${elapsedSeconds}s`
    return `${Math.floor(elapsedSeconds / 60)}m ${elapsedSeconds % 60}s`
  }, [elapsedSeconds])

  const loadTree = useCallback(async () => {
    try {
      const knowledgeTree = await window.electronAPI.getKnowledgeTree(avatarId)
      setTree(knowledgeTree)
    } catch (err) {
      console.error('[KnowledgePanel] 加载知识树失败:', err instanceof Error ? err.message : String(err))
    }
  }, [avatarId])

  useEffect(() => {
    loadTree()
  }, [loadTree])

  useEffect(() => {
    if (showNewFileDialog) {
      const t = setTimeout(() => newFileInputRef.current?.focus(), 50)
      return () => clearTimeout(t)
    }
  }, [showNewFileDialog])

  const handleSelectFile = async (filePath: string) => {
    const seq = ++fileSelectSeqRef.current
    setSelectedPath(filePath)
    setIsEditMode(false)
    setSearchResults([])
    const content = await window.electronAPI.readKnowledgeFile(avatarId, filePath)
    if (fileSelectSeqRef.current !== seq) return
    setFileContent(content)
    setEditedContent(content)
  }

  const showStatus = (msg: string, autoClear: boolean | number = true) => {
    setStatusMsg(msg)
    clearTimeout(statusTimerRef.current)
    if (autoClear !== false) {
      const delay = typeof autoClear === 'number' ? autoClear : 2500
      statusTimerRef.current = setTimeout(() => setStatusMsg(''), delay)
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
    try {
      const results = await window.electronAPI.searchKnowledge(avatarId, searchQuery)
      setSearchResults(results)
    } catch (err) {
      console.error('[KnowledgePanel] 搜索失败:', err instanceof Error ? err.message : String(err))
      setSearchResults([])
    } finally {
      setIsSearching(false)
    }
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
          { name: '支持的文件', extensions: ['pdf', 'docx', 'pptx', 'xlsx', 'xls', 'csv', 'txt', 'md', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] },
          { name: 'PDF 文件', extensions: ['pdf'] },
          { name: 'Word 文档', extensions: ['docx'] },
          { name: 'PowerPoint', extensions: ['pptx'] },
          { name: 'Excel 表格', extensions: ['xlsx', 'xls', 'csv'] },
          { name: '图片', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] },
          { name: '文本文件', extensions: ['txt', 'md'] },
        ],
        properties: ['openFile'],
      })
      if (result.canceled || result.filePaths.length === 0) return

      setIsImporting(true)
      setImportProgress({ current: 0, total: 5, phase: '准备中' })
      const filePath = result.filePaths[0]

      // 保留原始文件到 knowledge/_raw/（Karpathy 融合：source of truth 不丢失）
      try {
        await window.electronAPI.preserveRawFile(avatarId, filePath)
      } catch (rawErr) {
        console.warn('原始文件保留失败（不影响导入）:', rawErr)
      }

      showStatus('解析文档中...', false)
      setImportProgress({ current: 1, total: 5, phase: '解析文档' })

      const parsed = await window.electronAPI.parseDocument(filePath)

      if (!mountedRef.current) return

      // ── Excel/CSV 快速路径：parsed.text 已是结构化 GFM markdown，跳过
      // PDF 全文清理 / Vision OCR / LLM 逐章格式化等所有 pdf/word 专属处理。
      // 同时把 structuredData 写到 knowledge/_excel/<basename>.json 供
      // query_excel 工具精确过滤行；.md 文件顶部加 rag_only frontmatter
      // 告诉 SoulLoader 跳过 stuff，避免整个大表塞进 system prompt 炸上下文。
      if (parsed.fileType === 'excel') {
        const baseName = parsed.fileName.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_')
        const targetPath = `${baseName}.md`
        const sheetsYaml = parsed.sheetNames && parsed.sheetNames.length > 0
          ? parsed.sheetNames.map(s => `"${s.replace(/"/g, '\\"')}"`).join(', ')
          : ''
        // Frontmatter：rag_only=true 让 SoulLoader 跳过本文件，
        // source=excel 标记类型，excel_json 指向结构化数据位置
        const frontmatter = [
          '---',
          'rag_only: true',
          'source: excel',
          `excel_json: _excel/${baseName}.json`,
          sheetsYaml ? `sheets: [${sheetsYaml}]` : '',
          '---',
        ].filter(Boolean).join('\n')
        const finalContent = `${frontmatter}\n\n# ${parsed.fileName.replace(/\.[^.]+$/, '')}\n\n${parsed.text}\n`
        setImportProgress({ current: 3, total: 5, phase: '写入结构化数据' })
        if (parsed.structuredData) {
          try {
            await window.electronAPI.writeExcelData(avatarId, baseName, parsed.structuredData)
          } catch (excelErr) {
            console.warn('Excel JSON 写入失败（仍继续写 .md）:', excelErr)
          }
        }
        setImportProgress({ current: 4, total: 5, phase: '写入知识库' })
        await window.electronAPI.writeKnowledgeFile(avatarId, targetPath, finalContent)

        // 同步更新 README.md 索引（复用 pdf/word 同样的逻辑）
        try {
          let existingReadme = ''
          try {
            existingReadme = await window.electronAPI.readKnowledgeFile(avatarId, 'README.md')
          } catch (readErr) {
            void readErr
          }
          const sheetsLabel = parsed.sheetNames && parsed.sheetNames.length > 0
            ? `导入自 Excel / CSV（${parsed.sheetNames.length} 个 sheet）`
            : '导入自 Excel / CSV'
          const fileEntry = `| \`${targetPath}\` | ${parsed.fileName} | ${sheetsLabel} |`
          if (existingReadme && existingReadme.includes('_(暂无，待添加)_')) {
            const updatedReadme = existingReadme.replace('| _(暂无，待添加)_ | | |', fileEntry)
            await window.electronAPI.writeKnowledgeFile(avatarId, 'README.md', updatedReadme)
          } else if (existingReadme && !existingReadme.includes(targetPath)) {
            const tableEndPattern = /(\| .+ \| .+ \| .+ \|)\n\n## 图片/
            const match = existingReadme.match(tableEndPattern)
            if (match) {
              const updatedReadme = existingReadme.replace(tableEndPattern, `$1\n${fileEntry}\n\n## 图片`)
              await window.electronAPI.writeKnowledgeFile(avatarId, 'README.md', updatedReadme)
            }
          }
        } catch (readmeErr) {
          console.warn('README.md 回填失败（不影响导入）:', readmeErr)
        }

        setImportProgress({ current: 5, total: 5, phase: '刷新上下文' })
        await loadTree()
        // ⚠️ 关键：不再 handleSelectFile(targetPath)。
        // Excel 的 .md 文件可能很大（250 KB+ × 1000+ 行 markdown 表格），
        // 自动加载到 KnowledgeViewer 会让 react-markdown 渲染巨型表格卡死渲染器，
        // 导致"无法关闭知识库"/"无法编辑"。用户需要手动点击文件查看，
        // 而 Viewer/Editor 会检测 source:excel frontmatter 显示摘要而非全表。
        //
        // ⚠️ 关键：必须 await onSaved，等 App 的 handleKnowledgeSaved
        // 跑完 loadAvatarConfig 重建 system prompt 后才返回，
        // 否则用户立刻发问会用旧的 stale system prompt（原 Excel 248k 字符塞满 context）。
        await onSaved?.()
        showStatus(`✓ 已导入并刷新上下文: ${targetPath}`)
        return
      }

      // ── pptx 快速路径（跳过 LLM 格式化，文本已按幻灯片页分好结构）──
      if (parsed.fileType === 'pptx') {
        const baseName = parsed.fileName.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_')
        const targetPath = `${baseName}.md`
        const frontmatter = `---\nrag_only: true\nsource: pptx\n---\n\n`
        const finalContent = frontmatter + `# ${parsed.fileName.replace(/\.[^.]+$/, '')}\n\n${parsed.text}\n`
        setImportProgress({ current: 3, total: 4, phase: '写入知识库' })
        await window.electronAPI.writeKnowledgeFile(avatarId, targetPath, finalContent)
        setImportProgress({ current: 4, total: 4, phase: '刷新上下文' })
        await loadTree()
        await onSaved?.()
        showStatus(`✓ 已导入 PowerPoint: ${targetPath}`)
        return
      }

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
          setImportProgress({ current: 2, total: 5, phase: `图纸解读 ${i + 1}/${parsed.images.length}` })
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
        setImportProgress({ current: 3, total: 5, phase: 'LLM 格式化' })

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
        } catch (readErr) {
          // README 不存在是合法状态（新分身），不记日志
          void readErr
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
          setImportProgress({ current: 4, total: 5, phase: '构建检索索引' })
          const indexResult = await window.electronAPI.buildKnowledgeIndex(avatarId, indexApiKey, indexBaseUrl)
          console.warn(`检索索引构建完成：${indexResult.contextCount} 上下文，${indexResult.embeddingCount} 向量`)
        } catch (indexErr) {
          console.warn('检索索引构建失败（不影响导入）:', indexErr)
        }
      }
      if (!mountedRef.current) return

      // Phase 2: 知识演化检测（导入后自动检测与已有知识的差异）
      const evolutionModel = creationModel?.apiKey ? creationModel : chatModel
      if (evolutionModel?.apiKey && finalContent.length > 200) {
        try {
          setIsDetectingEvolution(true)
          showStatus('知识演化检测中...', false)
          setImportProgress({ current: 5, total: 5, phase: '演化检测' })
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
      setImportProgress(null)
    }
  }

  /**
   * 批量导入文件夹：选一个文件夹 → 递归 walk → 逐个解析写入。
   * 跳过 LLM 格式化以保证速度；单文件导入仍享受完整管线。
   */
  const handleImportFolder = async () => {
    try {
      const result = await window.electronAPI.showOpenDialog({
        title: '选择要批量导入的文件夹',
        properties: ['openDirectory'],
      })
      if (result.canceled || result.filePaths.length === 0) return

      setIsBatchImporting(true)
      setBatchResult(null)
      setImportProgress({ current: 0, total: 0, phase: '正在扫描文件夹...' })
      showStatus('批量导入中...', false)

      const folderPath = result.filePaths[0]
      const batch = await window.electronAPI.importFolder(avatarId, folderPath)
      if (!mountedRef.current) return

      setBatchResult(batch)
      showStatus(
        `✓ 成功 ${batch.imported.length} | 跳过 ${batch.skipped.length} | 失败 ${batch.failed.length}`,
        10000,
      )
      if (batch.skipped.length > 0 || batch.failed.length > 0) {
        setShowBatchLog(true)
      }
      await loadTree()
      onSaved?.()
      // 导入成功后自动询问是否优化质量
      if (batch.imported.length > 0) {
        promptEnhanceAfterBatch(batch.imported.map(f => f.targetPath))
      }
    } catch (err) {
      console.error('批量导入文件夹失败:', err)
      showStatus('✗ 批量导入失败: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setIsBatchImporting(false)
      setImportProgress(null)
    }
  }

  /**
   * 批量导入归档：选一个 .zip/.tar.gz/.7z/.rar → 解压到 temp → walk → 批量写入 → 清理。
   */
  const handleImportArchive = async () => {
    try {
      const result = await window.electronAPI.showOpenDialog({
        title: '选择要导入的压缩包',
        filters: [
          { name: '压缩包', extensions: ['zip', 'tar.gz', 'tgz', '7z', 'rar'] },
          { name: 'ZIP', extensions: ['zip'] },
          { name: 'TAR.GZ', extensions: ['tar.gz', 'tgz'] },
          { name: '7Z', extensions: ['7z'] },
          { name: 'RAR', extensions: ['rar'] },
        ],
        properties: ['openFile'],
      })
      if (result.canceled || result.filePaths.length === 0) return

      setIsBatchImporting(true)
      setBatchResult(null)
      setImportProgress({ current: 0, total: 0, phase: '正在解压归档...' })
      showStatus('解压 + 批量导入中...', false)

      const archivePath = result.filePaths[0]
      const batch = await window.electronAPI.importArchive(avatarId, archivePath)
      if (!mountedRef.current) return

      setBatchResult(batch)
      showStatus(
        `✓ 成功 ${batch.imported.length} | 跳过 ${batch.skipped.length} | 失败 ${batch.failed.length}`,
        10000,
      )
      if (batch.skipped.length > 0 || batch.failed.length > 0) {
        setShowBatchLog(true)
      }
      await loadTree()
      onSaved?.()
      // 导入成功后自动询问是否优化质量
      if (batch.imported.length > 0) {
        promptEnhanceAfterBatch(batch.imported.map(f => f.targetPath))
      }
    } catch (err) {
      console.error('批量导入归档失败:', err)
      showStatus('✗ 批量导入失败: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setIsBatchImporting(false)
      setImportProgress(null)
    }
  }

  /** 批量导入完成后自动开始质量优化（只处理本次导入的文件） */
  const promptEnhanceAfterBatch = (importedFiles: string[]) => {
    if (importedFiles.length === 0) return
    // 不在此处检查 model（会被闭包捕获变成 stale），handleEnhanceKnowledge 内部会实时获取
    setTimeout(() => {
      if (mountedRef.current) {
        handleEnhanceKnowledge(importedFiles).catch(err => {
          console.error('自动优化失败:', err)
        })
      }
    }, 300)
  }

  const handleEnhanceKnowledge = async (targetFiles?: string[]) => {
    const model = creationModel?.apiKey ? creationModel : chatModel
    if (!model?.apiKey) {
      showStatus('✗ 需要先配置 API Key')
      return
    }
    setIsEnhancing(true)
    setEnhanceProgress(null)
    showStatus('知识库质量优化中（完整管线：OCR → 清洗 → 格式化 → 校验）...', false)
    try {
      const result = await window.electronAPI.enhanceKnowledgeFiles(
        avatarId,
        model.apiKey,
        model.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model.model || 'qwen-plus',
        ocrModel?.apiKey,
        ocrModel?.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        targetFiles,
      )
      if (!mountedRef.current) return
      if (result.total === 0) {
        showStatus('没有需要优化的文件（仅处理批量导入的未格式化文件）')
      } else {
        const fabMsg = result.fabricatedWarnings > 0 ? ` | ${result.fabricatedWarnings} 个疑似编造数值` : ''
        showStatus(`✓ 优化完成：${result.enhanced} 成功 / ${result.failed} 失败 / 共 ${result.total} 个${fabMsg}`, 10000)

        // 优化完成后重建检索索引（上下文摘要 + 向量嵌入）
        const indexApiKey = ocrModel?.apiKey || model.apiKey
        const indexBaseUrl = ocrModel?.baseUrl || model.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
        if (indexApiKey && result.enhanced > 0) {
          try {
            showStatus('重建检索索引（上下文摘要 + 向量嵌入）...', false)
            const indexResult = await window.electronAPI.buildKnowledgeIndex(avatarId, indexApiKey, indexBaseUrl)
            showStatus(`✓ 优化 + 索引完成：${result.enhanced} 文件${fabMsg} | ${indexResult.contextCount} 摘要 + ${indexResult.embeddingCount} 向量`, 10000)
          } catch (indexErr) {
            console.warn('索引构建失败（不影响优化结果）:', indexErr)
          }
        }
      }
      await loadTree()
      onSaved?.()
    } catch (err) {
      console.error('知识库优化失败:', err)
      showStatus('✗ 优化失败: ' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setIsEnhancing(false)
      setEnhanceProgress(null)
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
    showStatus('正在生成知识百科...', false)
    try {
      const baseUrl = model.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
      const result = await window.electronAPI.compileWiki(avatarId, model.apiKey, baseUrl)
      showStatus(`✓ 已生成 ${result.conceptPageCount} 个百科词条 · 前往「设置 → 知识百科」开启后，AI 回答时会自动参考`, 10000)
    } catch (err) {
      console.error('百科编译失败:', err)
      showStatus('✗ 百科生成失败，请检查 API Key 配置')
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
    showStatus('正在检查知识一致性...', false)
    try {
      const baseUrl = model.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1'
      const report = await window.electronAPI.lintKnowledge(avatarId, model.apiKey, baseUrl)
      if (report.issueCount === 0) {
        showStatus(`✓ 自检通过：${report.totalFiles} 个文件，${report.totalChunks} 个片段，未发现问题`, 8000)
      } else {
        showStatus(`⚠ 发现 ${report.issueCount} 个问题（${report.issues.filter(i => i.type === 'contradiction').length} 矛盾，${report.issues.filter(i => i.type === 'duplicate').length} 重复）`, 10000)
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
              disabled={isImporting || isBatchImporting}
              className="pixel-btn-outline-light disabled:opacity-40"
              aria-label="导入文档（单文件，支持 LLM 格式化）"
              title="单文件导入，PDF/Word 会经 LLM 重新格式化"
            >
              {isImporting ? '...' : 'IMPORT'}
            </button>
            <button
              onClick={handleImportFolder}
              disabled={isImporting || isBatchImporting}
              className="pixel-btn-outline-light disabled:opacity-40"
              aria-label="批量导入文件夹"
              title="批量导入整个文件夹（跳过 LLM 格式化以保证速度）"
            >
              {isBatchImporting ? '...' : '[📁] FOLDER'}
            </button>
            <button
              onClick={handleImportArchive}
              disabled={isImporting || isBatchImporting}
              className="pixel-btn-outline-light disabled:opacity-40"
              aria-label="导入压缩包"
              title="支持 zip / tar.gz / 7z / rar"
            >
              {isBatchImporting ? '...' : '[📦] ARCHIVE'}
            </button>
            <button
              onClick={() => handleEnhanceKnowledge()}
              disabled={isBusy}
              className="pixel-btn-outline-light disabled:opacity-40"
              aria-label="优化知识库质量"
              title="对批量导入的文件补跑 LLM 格式化，提升检索质量"
            >
              {isEnhancing ? (enhanceProgress ? `${enhanceProgress.current}/${enhanceProgress.total}` : '...') : '[✨] ENHANCE'}
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

      {/* 批量导入结果抽屉：成功/跳过/失败明细 */}
      {batchResult && (
        <div className="px-6 py-3 border-b-2 border-px-border bg-px-elevated/30">
          <button
            onClick={() => setShowBatchLog(!showBatchLog)}
            className="font-game text-[12px] text-px-primary tracking-wider hover:underline"
          >
            {showBatchLog ? '▼' : '▶'} 批量导入日志 (成功 {batchResult.imported.length} · 跳过 {batchResult.skipped.length} · 失败 {batchResult.failed.length})
          </button>
          {showBatchLog && (() => {
            // 限制 DOM 渲染数量：成功列表超 50 条只显示前 50 + 汇总，跳过/失败全部显示
            const MAX_SHOW = 50
            const imported = batchResult.imported
            const showImported = imported.length > MAX_SHOW ? imported.slice(0, MAX_SHOW) : imported
            const hiddenCount = imported.length - showImported.length
            return (
              <div className="mt-3 text-[11px] font-mono text-px-text-sec max-h-48 overflow-y-auto space-y-1">
                {showImported.map((item, i) => (
                  <div key={`ok-${i}`} className="text-px-success">✓ {item.fileName}</div>
                ))}
                {hiddenCount > 0 && (
                  <div className="text-px-text-dim">... 另有 {hiddenCount} 个成功文件未显示</div>
                )}
                {batchResult.skipped.slice(0, MAX_SHOW).map((item, i) => (
                  <div key={`skip-${i}`} className="text-px-text-dim">○ {item.path.split('/').pop()} — {item.reason}</div>
                ))}
                {batchResult.skipped.length > MAX_SHOW && (
                  <div className="text-px-text-dim">... 另有 {batchResult.skipped.length - MAX_SHOW} 个跳过文件未显示</div>
                )}
                {batchResult.failed.slice(0, MAX_SHOW).map((item, i) => (
                  <div key={`fail-${i}`} className="text-px-danger">✗ {item.path.split('/').pop()} — {item.error}</div>
                ))}
                {batchResult.failed.length > MAX_SHOW && (
                  <div className="text-px-danger">... 另有 {batchResult.failed.length - MAX_SHOW} 个失败文件未显示</div>
                )}
              </div>
            )
          })()}
          <button
            onClick={() => { setBatchResult(null); setShowBatchLog(false) }}
            className="mt-2 font-game text-[10px] text-px-text-dim hover:text-px-primary tracking-wider"
          >
            [✕] 关闭日志
          </button>
        </div>
      )}

      {/* 进度条（导入 / 百科编译 / 知识自检） */}
      {isBusy && statusMsg && (
        <div className="px-6 py-3 border-b-2 border-px-primary/30 bg-px-primary/5">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-3">
              <div className="w-4 h-4 border-2 border-px-primary border-t-transparent rounded-full animate-spin" />
              <span className="font-game text-[13px] text-px-primary tracking-wider">{statusMsg}</span>
            </div>
            <span className="font-game text-[12px] text-px-text-dim tracking-wider">{elapsedDisplay}</span>
          </div>
          {importProgress && importProgress.total > 0 ? (
            <div className="w-full h-1.5 bg-px-border rounded-none overflow-hidden">
              <div
                className="h-full bg-px-primary transition-all duration-300"
                style={{ width: `${Math.round((importProgress.current / importProgress.total) * 100)}%` }}
              />
            </div>
          ) : (
            <div className="w-full h-1.5 bg-px-border rounded-none overflow-hidden">
              <div className="h-full bg-px-primary pixel-progress-indeterminate" />
            </div>
          )}
          {(isCompiling || isLinting) && (
            <p className="font-game text-[12px] text-px-text-dim mt-2">
              {isCompiling
                ? '正在从知识库中提取关键概念并生成百科词条，通常需要 30 秒 ~ 2 分钟，取决于知识库大小'
                : '正在检查知识文件间是否存在矛盾或重复内容，完成后会显示检查结果'}
            </p>
          )}
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
