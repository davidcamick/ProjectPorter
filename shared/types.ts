export const MOVE_CATEGORIES = [
  'Project Files',
  'Raw',
  'Assets',
  'Exports',
  'Deliverables',
  '_Needs Review',
  'Ignore',
] as const

export type MoveCategory = (typeof MOVE_CATEGORIES)[number]

export type ManifestKind = 'file' | 'folder'

export type ManifestItem = {
  id: string
  name: string
  relativePath: string
  kind: ManifestKind
  extension: string | null
  sizeBytes: number | null
  modifiedAt: string | null
  childCount?: number
  sampleChildren?: string[]
}

export type MovePlanItem = {
  id: string
  sourceRelativePath: string
  destinationRelativePath: string
  category: MoveCategory
  confidence: number
  reason: string
  requiresReview: boolean
  suggestedOnly?: boolean
}

export type ClassifyRequest = {
  projectName: string
  sourceRootName: string
  manifest: ManifestItem[]
  deterministicHints: {
    plan: MovePlanItem[]
    detectedApps: string[]
    warnings: string[]
  }
}

export type ClassifyResponse = {
  plan: MovePlanItem[]
  detectedApps: string[]
  warnings: string[]
  summary: string
}

export type ScanTotals = {
  files: number
  folders: number
  sizeBytes: number
}

export type ReviewPlanItem = MovePlanItem & {
  enabled: boolean
  warning?: string
}

export type DeliverableCandidate = {
  id: string
  sourceRelativePath: string
  destinationRelativePath: string
  name: string
  extension: string | null
  sizeBytes: number | null
  likely: boolean
  selected: boolean
}

export type ApplyLogItem = {
  id: string
  source: string
  destination: string
  action: 'copy' | 'move' | 'skip' | 'report' | 'error'
  status: 'pending' | 'running' | 'done' | 'error'
  message?: string
}
