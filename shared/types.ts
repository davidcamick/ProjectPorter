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

export type OrganizationMode = 'rules-only' | 'rules-plus-ai-review' | 'force-ai-debug'

export type PlanSource =
  | 'Smart Rules'
  | 'Smart Rules + AI Review'
  | 'Smart Rules + AI Review Failed; Used Smart Rules'
  | 'Mock'

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
  hiddenSystem?: boolean
}

export type DeterministicPlanItem = {
  id: string
  sourceRelativePath: string
  destinationRelativePath: string
  category: MoveCategory
  confidence: number
  reason: string
  requiresReview: boolean
  source: 'rules'
  operation?: 'move' | 'delete'
  preserveDestinationRelativePath?: string
  suggestedOnly?: boolean
}

export type MovePlanItem = DeterministicPlanItem & {
  aiReviewed?: boolean
}

export type AiReviewOverride = {
  id: string
  action: 'keep' | 'change_destination' | 'mark_needs_review' | 'ignore'
  destinationRelativePath: string | null
  category: MoveCategory | null
  confidence: number
  reason: string
}

export type AiReviewResponse = {
  summary: string
  overrides: AiReviewOverride[]
  warnings: string[]
  recommendedUserQuestions: string[]
}

export type DeterministicPlanSummary = {
  totalItems: number
  enabledItems: number
  needsReviewItems: number
  byCategory: Record<MoveCategory, number>
  lowConfidenceItems: number
}

export type RootFolderSummary = {
  totalRootItems: number
  files: number
  folders: number
  canonicalFoldersPresent: string[]
  variantCanonicalFolders: Array<{ name: string; canonicalName: string; relativePath: string }>
}

export type CompactAiSettings = {
  maxAiItems: number
  maxSampleChildrenPerFolder: number
  maxAiPayloadBytes: number
}

export type AiEstimatedTokenRisk = 'low' | 'medium' | 'high'

export type AiReviewCandidateBase = {
  id: string
  name: string
  relativePath: string
  deterministicDestination: string
  deterministicConfidence: number
  deterministicReason: string
  whySentToAi: string[]
}

export type AiReviewFolderCandidate = AiReviewCandidateBase & {
  kind: 'folder'
  childCount: number
  totalFileCount: number
  totalFolderCount: number
  totalSizeBytes: number
  extensionCounts: Record<string, number>
  topLevelSampleChildren: string[]
  detectedAppsInside: string[]
  containsVideo: boolean
  containsAudio: boolean
  containsProjectFiles: boolean
  containsCache: boolean
  containsExports: boolean
  containsImages: boolean
  containsArchives: boolean
  maxDepth: number
}

export type AiReviewFileCandidate = AiReviewCandidateBase & {
  kind: 'file'
  extension: string | null
  sizeBytes: number | null
  modifiedAt: string | null
}

export type AiReviewCandidate = AiReviewFolderCandidate | AiReviewFileCandidate

export type AiReviewGroupedSummary = {
  id: string
  kind: 'group'
  parentPath: string
  extension: string | null
  namePattern: string
  count: number
  deterministicDestination: string
  deterministicConfidenceRange: [number, number]
  whySentToAi: string[]
  sampleNames: string[]
}

export type CompactAiReviewPacket = {
  projectName: string
  projectDate: string
  sourceRootName: string
  mode: 'in-place' | 'import'
  organizationMode: OrganizationMode
  deterministicPlanSummary: DeterministicPlanSummary
  rootFolderSummary: RootFolderSummary
  detectedApps: string[]
  folderCandidates: AiReviewFolderCandidate[]
  ambiguousItems: AiReviewCandidate[]
  suspiciousItems: AiReviewCandidate[]
  deliverableCandidates: AiReviewFileCandidate[]
  groupedSummaries: AiReviewGroupedSummary[]
  validationWarningsBeforeApply: string[]
  aiSettings: CompactAiSettings
  aiEstimatedTokenRisk: AiEstimatedTokenRisk
  compacted: boolean
  warnings: string[]
}

export type ClassifyRequest = CompactAiReviewPacket

export type ClassifyResponse = {
  plan: MovePlanItem[]
  detectedApps: string[]
  warnings: string[]
  summary: string
}

export type AiClassifyResponse = AiReviewResponse & {
  model?: string
  usage?: unknown
  detectedApps?: string[]
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
  action: 'copy' | 'move' | 'delete' | 'skip' | 'report' | 'cleanup' | 'validate' | 'error'
  status: 'pending' | 'running' | 'done' | 'error'
  message?: string
}

export type BackendHealth = {
  ok: boolean
  model: string
  hasApiKey: boolean
}

export type AiStatus = {
  organizationMode: OrganizationMode
  backendHealth: unknown
  aiEnabled: boolean
  aiRequestStarted: string | null
  aiRequestCompleted: string | null
  aiDurationMs: number | null
  aiItemsSentCount: number
  aiEstimatedTokenRisk: AiEstimatedTokenRisk
  aiFallbackUsed: boolean
  aiFallbackReason: string
  aiErrorMessage: string
  aiErrorStack?: string
  model: string
  responseSummary: string
  warnings: string[]
}

export type ValidationSeverity = 'green' | 'yellow' | 'red'

export type ValidationIssue = {
  severity: Exclude<ValidationSeverity, 'green'>
  code: string
  path: string
  message: string
}

export type ValidationResult = {
  severity: ValidationSeverity
  message: string
  issues: ValidationIssue[]
}
