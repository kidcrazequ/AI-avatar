import { useState } from 'react'

interface Props {
  tree: FileNode[]
  onSelectFile: (path: string) => void
  selectedPath: string | null
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
          className="flex items-center gap-1.5 px-2 py-1.5 hover:bg-px-hover cursor-pointer group"
          style={{ paddingLeft: `${level * 12 + 8}px` }}
          onClick={() => setIsExpanded(!isExpanded)}
        >
          <svg className={`w-3 h-3 text-px-text-dim transition-none ${isExpanded ? '' : '-rotate-90'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="square" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
          <svg className="w-3.5 h-3.5 text-px-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="square" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>
          <span className="font-game text-[13px] font-medium text-px-text">{node.name}</span>
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
        className={`flex items-center gap-1.5 px-2 py-1.5 cursor-pointer group transition-none
          ${isSelected ? 'bg-px-primary/15 text-px-text border-l-2 border-l-px-primary -ml-0.5' : 'hover:bg-px-hover text-px-text-sec'}`}
        onClick={() => onSelectFile(node.path)}
      >
        <svg className="w-3.5 h-3.5 text-px-text-dim flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="square" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        <span className="font-game text-[13px] flex-1 truncate">{node.name}</span>
        {onRequestDelete && !isConfirmingDelete && (
          <button
            className="opacity-0 group-hover:opacity-100 text-px-text-dim hover:text-px-danger px-1"
            aria-label={`删除 ${node.name}`}
            onClick={(e) => { e.stopPropagation(); onRequestDelete(node.path) }}
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="square" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>
      {isConfirmingDelete && (
        <div className="flex items-center gap-1.5 px-2 py-1.5 bg-px-danger/10 border-l-2 border-px-danger ml-4">
          <span className="font-game text-[11px] text-px-danger tracking-wider">删除?</span>
          <button
            className="font-game text-[11px] px-2 py-0.5 bg-px-danger text-white"
            onClick={() => onConfirmDelete?.(node.path)}
          >
            是
          </button>
          <button
            className="font-game text-[11px] px-2 py-0.5 border border-px-border text-px-text-sec"
            onClick={onCancelDelete}
          >
            否
          </button>
        </div>
      )}
    </div>
  )
}
