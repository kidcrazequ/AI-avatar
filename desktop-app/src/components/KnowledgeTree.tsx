import { useState } from 'react'

interface Props {
  tree: FileNode[]
  onSelectFile: (path: string) => void
  selectedPath: string | null
  /** GAP7: 内联删除确认状态 */
  confirmDeletePath?: string | null
  onRequestDelete?: (path: string) => void
  onConfirmDelete?: (path: string) => void
  onCancelDelete?: () => void
}

export default function KnowledgeTree({
  tree, onSelectFile, selectedPath,
  confirmDeletePath, onRequestDelete, onConfirmDelete, onCancelDelete,
}: Props) {
  return (
    <div className="p-2">
      {tree.map((node) => (
        <TreeNode
          key={node.path}
          node={node}
          onSelectFile={onSelectFile}
          selectedPath={selectedPath}
          level={0}
          confirmDeletePath={confirmDeletePath}
          onRequestDelete={onRequestDelete}
          onConfirmDelete={onConfirmDelete}
          onCancelDelete={onCancelDelete}
        />
      ))}
    </div>
  )
}

interface TreeNodeProps {
  node: FileNode
  onSelectFile: (path: string) => void
  selectedPath: string | null
  level: number
  confirmDeletePath?: string | null
  onRequestDelete?: (path: string) => void
  onConfirmDelete?: (path: string) => void
  onCancelDelete?: () => void
}

function TreeNode({
  node, onSelectFile, selectedPath, level,
  confirmDeletePath, onRequestDelete, onConfirmDelete, onCancelDelete,
}: TreeNodeProps) {
  const [isExpanded, setIsExpanded] = useState(true)
  const isSelected = selectedPath === node.path
  const isConfirmingDelete = confirmDeletePath === node.path

  if (node.type === 'directory') {
    return (
      <div>
        <div
          className="flex items-center gap-1 px-2 py-1.5 hover:bg-px-warm cursor-pointer group"
          style={{ paddingLeft: `${level * 12 + 8}px` }}
          onClick={() => setIsExpanded(!isExpanded)}
        >
          <span className="font-mono text-px-muted text-xs w-3 select-none">
            {isExpanded ? '▼' : '▶'}
          </span>
          <span className="font-mono text-xs font-semibold text-px-black">{node.name}/</span>
        </div>
        {isExpanded && node.children && (
          <div>
            {node.children.map((child) => (
              <TreeNode
                key={child.path}
                node={child}
                onSelectFile={onSelectFile}
                selectedPath={selectedPath}
                level={level + 1}
                confirmDeletePath={confirmDeletePath}
                onRequestDelete={onRequestDelete}
                onConfirmDelete={onConfirmDelete}
                onCancelDelete={onCancelDelete}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div style={{ paddingLeft: `${level * 12 + 20}px` }}>
      <div
        className={`flex items-center gap-1 px-2 py-1.5 cursor-pointer group
          ${isSelected ? 'bg-px-black text-px-white' : 'hover:bg-px-warm text-px-black'}`}
        onClick={() => onSelectFile(node.path)}
      >
        <span className="font-mono text-xs text-px-muted select-none">-</span>
        <span className="font-mono text-xs flex-1 truncate">{node.name}</span>
        {/* GAP7: 删除按钮（hover 显示） */}
        {onRequestDelete && !isConfirmingDelete && (
          <button
            className="opacity-0 group-hover:opacity-100 font-pixel text-[8px] text-px-muted hover:text-px-danger px-1"
            aria-label={`删除 ${node.name}`}
            onClick={(e) => { e.stopPropagation(); onRequestDelete(node.path) }}
          >
            ×
          </button>
        )}
      </div>
      {/* GAP7: 内联删除确认（替代 window.confirm） */}
      {isConfirmingDelete && (
        <div className="flex items-center gap-1 px-2 py-1 bg-px-warm border-l-2 border-px-danger ml-4">
          <span className="font-pixel text-[8px] text-px-danger">DELETE?</span>
          <button
            className="font-pixel text-[8px] px-1.5 py-0.5 bg-px-danger text-px-white"
            onClick={() => onConfirmDelete?.(node.path)}
          >
            DEL
          </button>
          <button
            className="font-pixel text-[8px] px-1.5 py-0.5 border border-px-border text-px-muted"
            onClick={onCancelDelete}
          >
            NO
          </button>
        </div>
      )}
    </div>
  )
}
