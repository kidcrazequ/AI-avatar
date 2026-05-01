/**
 * 资产审阅面板（占位实现）。
 *
 * @author zhi.qu
 * @date 2026-04-28
 */

interface AssetItem {
  asset: string
  path: string
  status?: 'needs-review' | 'approved' | 'changes-requested'
  group?: string
}

interface Props {
  items: AssetItem[]
}

export default function AssetReviewPanel({ items }: Props) {
  return (
    <div className="h-full overflow-auto p-3 bg-px-bg border-l border-px-border">
      <div className="font-game text-[12px] text-px-text-dim mb-2">资产审阅</div>
      <div className="space-y-2">
        {items.map((it) => (
          <div key={`${it.asset}:${it.path}`} className="border border-px-border p-2 text-[12px]">
            <div className="font-medium">{it.asset}</div>
            <div className="text-px-text-dim">{it.path}</div>
            <div className="text-px-text-dim">{it.group ?? 'Ungrouped'} · {it.status ?? 'needs-review'}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

