/**
 * 工具内部名称 → 中文显示名映射（共享给 ChatWindow / TaskListPanel）。
 *
 * 抽取原因（Stage 三 P2 #14）：
 *   - ChatWindow 顶部「思考中…」状态显示当前工具中文名
 *   - TaskListPanel 在每个任务下展示已关联的工具调用，也需要中文名
 *   - 保持单一来源，避免两处维护漂移
 *
 * 未在表中的工具名直接原样展示，不会报错。
 *
 * @author zhi.qu
 * @date 2026-04-29
 */

export const TOOL_NAME_MAP: Record<string, string> = {
  // ─── 文件读写（精简后） ────────────────────────────────────────────────
  read_lines: '按行读取文件',
  glob: 'Glob 模式匹配',
  multi_edit: '批量编辑文件',
  // ─── 旧工具兼容映射（已从 AVATAR_TOOLS 移除，保留中文名以便日志可读） ─────
  read_file: '读取工作区文件',
  write_file: '写入工作区文件',
  list_files: '列出工作区文件',
  grep: '检索工作区内容',
  copy_files: '复制工作区文件',
  str_replace_edit: '字符串替换编辑',
  delete_file: '删除工作区文件',
  delegate_task: '委派子任务',
  register_assets: '注册资产',
  unregister_assets: '移除资产',
  show_to_user: '预览用户窗口',
  show_html: '预览隐藏窗口',
  eval_js: '执行 JS',
  eval_js_user_view: '执行用户视图 JS',
  get_webview_logs: '读取预览日志',
  save_screenshot: '保存截图',
  multi_screenshot: '多步截图',
  screenshot_user_view: '用户视图截图',
  done: '交付并校验',
  fork_verifier_agent: '后台校验',
  questions_v2: '结构化提问',
  copy_starter_component: '复制 starter',
  save_as_html: '导出 HTML',
  save_as_pdf: '导出 PDF',
  export_pptx: '导出 PPTX',
  gen_pptx: '生成 PPTX',
  super_inline_html: 'HTML 单文件打包',
  open_for_print: '打开打印视图',
  present_fs_item_for_download: '展示下载文件',
  get_public_file_url: '获取公开文件 URL',
  connect_github: '连接 GitHub',
  github_list_repos: '列出 GitHub 仓库',
  github_get_tree: '读取仓库目录',
  github_read_file: '读取仓库文件',
  github_import_files: '导入仓库文件',
  send_to_canva: '送到 Canva',
  read_pdf: '解析 PDF',
  read_docx: '解析 Word',
  read_pptx: '解析 PPTX',
  read_attachment: '读取对话附件',
  search_attachment: '检索对话附件',
  apply_tweaks: '应用 Tweaks',
  snip: '登记上下文裁剪',
  list_knowledge_files: '列出知识文件',
  lookup_policy: '查询电价政策',
  compare_products: '对比产品参数',
  semantic_search: '语义检索知识库',
  search_knowledge: '检索知识库',
  read_knowledge_file: '读取知识文件',
  match_palace_rooms: '匹配记忆宫殿路线',
  build_palace_context_card: '生成任务前上下文包',
  write_palace_room: '写入记忆宫殿路线卡',
  list_palace_commitments: '查看承诺账本',
  add_palace_commitment: '新增承诺记录',
  update_palace_commitment: '更新承诺状态',
  list_palace_inbox: '查看沉淀收件箱',
  add_palace_inbox_item: '新增沉淀候选',
  update_palace_inbox_item: '更新沉淀状态',
  list_design_systems: '列出设计系统',
  read_design_system: '读取设计系统',
  search_design_systems: '检索设计系统',
  calculate_roi: '计算储能收益',
  load_skill: '加载技能定义',
  query_excel: '查询表格数据',
  todo_write: '更新任务列表',
  exec_shell: '执行命令',
  exec_code: '执行脚本',
  await_shell: '等待后台命令',
  kill_shell: '终止后台命令',
  web_search: '搜索网页',
  web_fetch: '抓取网页',
  list_mcp_tools: '查看 MCP 工具',
  call_mcp_tool: '调用 MCP 工具',
  task: '委派子任务',
  ask_question: '向用户提问',
  generate_image: '生成图片',
  switch_mode: '切换工作模式',
}

/**
 * 显示一次工具调用的中文名 + 耗时，用于任务行下的工具列表。
 *
 * @example
 *   formatToolCallLabel({ id, name: 'query_excel', durationMs: 750, ok: true })
 *   // → "查询表格数据 · 750ms"
 */
export function formatToolCallLabel(name: string, durationMs: number): string {
  const cn = TOOL_NAME_MAP[name] ?? name
  return `${cn} · ${durationMs}ms`
}
