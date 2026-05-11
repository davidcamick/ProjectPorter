import type { ApplyLogItem, DeliverableCandidate, ReviewPlanItem, ScanTotals } from '../../shared/types.ts'
import { formatBytes } from './path.ts'

export type OrganizationReport = {
  appName: 'Project Porter'
  createdAt: string
  projectName: string
  sourceFolder: string
  destinationFolder: string
  mode: 'organize-in-place' | 'import-to-destination'
  copyDeliverables: boolean
  totals: ScanTotals
  appliedPlan: ReviewPlanItem[]
  skippedPlan: ReviewPlanItem[]
  deliverables: DeliverableCandidate[]
  logs: ApplyLogItem[]
  warnings: string[]
  finalTree: string[]
}

export function generateReportJson(report: OrganizationReport) {
  return JSON.stringify(report, null, 2)
}

export function generateReportMarkdown(report: OrganizationReport) {
  const appliedMoves = report.logs.filter((item) => item.status === 'done' && (item.action === 'move' || item.action === 'copy'))
  const errors = report.logs.filter((item) => item.status === 'error')

  return [
    '# Project Porter Organization Report',
    '',
    `Created: ${report.createdAt}`,
    `Project: ${report.projectName}`,
    `Source: ${report.sourceFolder}`,
    `Destination: ${report.destinationFolder}`,
    `Mode: ${report.mode}`,
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
      ? appliedMoves.map((item) => `- ${item.action.toUpperCase()}: ${item.source} -> ${item.destination}`).join('\n')
      : '- No move or copy operations were applied.',
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
    '## Errors',
    '',
    errors.length ? errors.map((item) => `- ${item.source}: ${item.message ?? 'Unknown error'}`).join('\n') : '- None.',
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
