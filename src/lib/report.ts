import type {
  AiStatus,
  ApplyLogItem,
  DeliverableCandidate,
  ManifestItem,
  OrganizationMode,
  ReviewPlanItem,
  ScanTotals,
  ValidationResult,
} from '../../shared/types.ts'
import { formatBytes } from './path.ts'

export type OrganizationReport = {
  appName: 'Project Porter'
  createdAt: string
  projectName: string
  sourceFolder: string
  destinationFolder: string
  mode: 'organize-in-place' | 'import-to-destination'
  organizationMode: OrganizationMode
  aiUsed: boolean
  aiCandidateCount: number
  aiFallbackReason: string
  copyDeliverables: boolean
  deleteCacheFiles: boolean
  totals: ScanTotals
  appliedPlan: ReviewPlanItem[]
  skippedPlan: ReviewPlanItem[]
  deliverables: DeliverableCandidate[]
  logs: ApplyLogItem[]
  cleanupActions: ApplyLogItem[]
  validation: ValidationResult | null
  warnings: string[]
  errors: string[]
  finalTree: string[]
}

export type DebugLog = {
  appName: 'Project Porter'
  createdAt: string
  purpose: string
  environment: {
    userAgent: string
    language: string
    platform: string
    location: string
    fileSystemAccessSupported: boolean
    backendHealth: unknown
  }
  settings: {
    projectName: string
    projectDate: string
    finalFolderName: string
    sourceRootName: string
    destinationRootName: string | null
    mode: 'organize-in-place' | 'import-to-destination'
    copyDeliverables: boolean
    deleteCacheFiles: boolean
    mockMode: boolean
    reportPath: string
    organizationMode: OrganizationMode
    showHiddenSystemFiles: boolean
    aiSettings: unknown
  }
  aiStatus: AiStatus
  aiReviewPacket: unknown
  aiResponseSummary: unknown
  validationResults: ValidationResult | null
  cleanupActions: ApplyLogItem[]
  runtimeEvents: unknown[]
  workflowState: {
    currentStep: string
    reviewed: boolean
    planSource: string
    planSummary: string
    detectedApps: string[]
    warnings: string[]
    needsReviewCount: number
    totalPlannedSizeBytes: number
    applyError: string
  }
  beforeScan: {
    rootName: string
    totals: ScanTotals
    manifest: ManifestItem[]
  }
  classification: {
    reviewItems: ReviewPlanItem[]
    enabledPlanItems: ReviewPlanItem[]
    skippedPlanItems: ReviewPlanItem[]
    deliverables: DeliverableCandidate[]
    selectedDeliverables: DeliverableCandidate[]
  }
  apply: {
    timing: unknown
    progress: unknown
    feed: unknown[]
    fileRecords: unknown[]
    logs: ApplyLogItem[]
  }
  afterScan: null | {
    rootName: string
    totals: ScanTotals
    manifest: ManifestItem[]
    tree: string[]
  }
  commandOutputs: Array<{
    label: string
    command: string | null
    output: string
    exitCode: number | null
    capturedAt: string
    note?: string
  }>
  notes: string[]
}

export type CompactDebugLog = Omit<DebugLog, 'beforeScan' | 'afterScan'> & {
  debugDepth: 'compact'
  beforeScan: {
    rootName: string
    totals: ScanTotals
    tree: unknown
  }
  afterScan: null | {
    rootName: string
    totals: ScanTotals
    tree: unknown
  }
  aiReviewPacketSummary: unknown
  aiResponseSummary: unknown
  validationResults: ValidationResult | null
}

export type CleanupReport = {
  appName: 'Project Porter'
  createdAt: string
  sourceFolder: string
  mode: 'cleanup-existing-organized-project'
  organizationMode: 'rules-only'
  aiUsed: false
  movedItems: ApplyLogItem[]
  cleanupActions: ApplyLogItem[]
  validation: ValidationResult | null
  warnings: string[]
  errors: string[]
  finalTree: string[]
}

export function generateReportJson(report: OrganizationReport) {
  return JSON.stringify(report, null, 2)
}

export function generateDebugLogJson(log: DebugLog) {
  return JSON.stringify(log, null, 2)
}

export function generateCompactDebugLogJson(log: CompactDebugLog) {
  return JSON.stringify(log, null, 2)
}

export function generateCleanupReportJson(report: CleanupReport) {
  return JSON.stringify(report, null, 2)
}

export function generateReportMarkdown(report: OrganizationReport) {
  const appliedMoves = report.logs.filter((item) => item.status === 'done' && (item.action === 'move' || item.action === 'copy' || item.action === 'delete'))
  const errors = report.logs.filter((item) => item.status === 'error')

  return [
    '# Project Porter Organization Report',
    '',
    `Created: ${report.createdAt}`,
    `Project: ${report.projectName}`,
    `Source: ${report.sourceFolder}`,
    `Destination: ${report.destinationFolder}`,
    `Mode: ${report.mode}`,
    `Organization mode: ${report.organizationMode}`,
    `AI used: ${report.aiUsed ? 'yes' : 'no'}`,
    `AI candidate count: ${report.aiCandidateCount}`,
    report.aiFallbackReason ? `AI fallback reason: ${report.aiFallbackReason}` : '',
    `Cache handling: ${report.deleteCacheFiles ? 'deleted cache/previews' : 'preserved cache/previews in Assets'}`,
    `Deliverables: ${report.deliverables.filter((item) => item.selected).length} selected (${report.copyDeliverables ? 'copied' : 'moved'})`,
    '',
    '## Scan Summary',
    '',
    `- Files: ${report.totals.files}`,
    `- Folders: ${report.totals.folders}`,
    `- Total size: ${formatBytes(report.totals.sizeBytes)}`,
    '',
    '## Applied Operations',
    '',
    appliedMoves.length
      ? appliedMoves.map((item) => (item.action === 'delete' ? `- DELETE: ${item.source}` : `- ${item.action.toUpperCase()}: ${item.source} -> ${item.destination}`)).join('\n')
      : '- No move, copy, or delete operations were applied.',
    '',
    '## Skipped Or Review Items',
    '',
    report.skippedPlan.length
      ? report.skippedPlan.map((item) => `- ${item.sourceRelativePath} (${item.category}): ${item.reason}`).join('\n')
      : '- None.',
    '',
    '## Warnings',
    '',
    report.warnings.length ? report.warnings.map((warning) => `- ${warning}`).join('\n') : '- None.',
    '',
    '## Validation',
    '',
    report.validation
      ? [`Status: ${report.validation.message}`, report.validation.issues.length ? report.validation.issues.map((item) => `- ${item.severity.toUpperCase()} ${item.path}: ${item.message}`).join('\n') : '- No issues found.'].join('\n')
      : '- Validation was not available.',
    '',
    '## Errors',
    '',
    errors.length || report.errors.length
      ? [...errors.map((item) => `${item.source}: ${item.message ?? 'Unknown error'}`), ...report.errors].map((message) => `- ${message}`).join('\n')
      : '- None.',
    '',
    '## Final Project Tree',
    '',
    '```',
    ...report.finalTree,
    '```',
    '',
    'Reminder: Premiere Pro and After Effects projects may need relinking after files are moved.',
    '',
  ].join('\n')
}

export function generateCleanupReportMarkdown(report: CleanupReport) {
  const errors = report.movedItems.filter((item) => item.status === 'error')

  return [
    '# Project Porter Cleanup Report',
    '',
    `Created: ${report.createdAt}`,
    `Source: ${report.sourceFolder}`,
    `Mode: ${report.mode}`,
    'AI used: no',
    '',
    '## Cleanup Operations',
    '',
    report.movedItems.length
      ? report.movedItems.map((item) => `- ${item.status.toUpperCase()}: ${item.source} -> ${item.destination || item.message || '-'}`).join('\n')
      : '- No cleanup operations were needed.',
    '',
    '## Empty Folder Cleanup',
    '',
    report.cleanupActions.length ? report.cleanupActions.map((item) => `- ${item.source}: ${item.message ?? 'Removed empty folder'}`).join('\n') : '- None.',
    '',
    '## Validation',
    '',
    report.validation
      ? [`Status: ${report.validation.message}`, report.validation.issues.length ? report.validation.issues.map((item) => `- ${item.severity.toUpperCase()} ${item.path}: ${item.message}`).join('\n') : '- No issues found.'].join('\n')
      : '- Validation was not available.',
    '',
    '## Warnings',
    '',
    report.warnings.length ? report.warnings.map((warning) => `- ${warning}`).join('\n') : '- None.',
    '',
    '## Errors',
    '',
    errors.length || report.errors.length
      ? [...errors.map((item) => `${item.source}: ${item.message ?? 'Unknown error'}`), ...report.errors].map((message) => `- ${message}`).join('\n')
      : '- None.',
    '',
    '## Final Project Tree',
    '',
    '```',
    ...report.finalTree,
    '```',
    '',
  ].join('\n')
}
