import type { ClassifyResponse, DeliverableCandidate, ManifestItem, MovePlanItem, ReviewPlanItem } from '../../shared/types.ts'
import { buildDeterministicClassification, sanitizePlan } from './deterministic.ts'
import { basenameOf, extensionOf, isDescendantPath, isSafeRelativePath, joinRelativePath } from './path.ts'

const likelyDeliverableWords = /(^|[\s._-])(final|master|delivery|deliverable|approved|upload|posted|client)(?=$|[\s._-])/i
const exportWords = /(^|[\s._-])(export|exports|final|finals|master|delivery|deliverable|approved|upload|posted|client|render|draft|review|youtube|instagram|tiktok|social|vertical|horizontal|v\d+)(?=$|[\s._-])/i
const deliverableExtensions = new Set(['.mp4', '.mov', '.m4v', '.avi', '.mxf', '.jpg', '.jpeg', '.png', '.webp', '.zip'])

export function finalizeClassification(response: ClassifyResponse, manifest: ManifestItem[]): ClassifyResponse {
  const deterministic = buildDeterministicClassification(manifest)
  const aiPlan = sanitizePlan(response.plan.map(enforceDeliverableConfirmation), manifest)
  const aiSources = new Set(aiPlan.map((item) => item.sourceRelativePath))
  const mergedPlan = sanitizePlan([...aiPlan, ...deterministic.plan.filter((item) => !aiSources.has(item.sourceRelativePath))], manifest)

  return {
    plan: mergedPlan,
    detectedApps: [...new Set([...response.detectedApps, ...deterministic.detectedApps])],
    warnings: [...new Set([...response.warnings, ...deterministic.warnings])],
    summary: response.summary,
  }
}

function enforceDeliverableConfirmation(item: MovePlanItem): MovePlanItem {
  if (item.category !== 'Deliverables') {
    return item
  }

  const name = basenameOf(item.sourceRelativePath)

  return {
    ...item,
    category: 'Exports',
    destinationRelativePath: joinRelativePath(['Exports', '_Loose Exports', name]),
    reason: `${item.reason} User confirmation is still required before it becomes a deliverable.`,
    requiresReview: true,
    suggestedOnly: true,
  }
}

export function createReviewItems(plan: MovePlanItem[], manifest: ManifestItem[]): ReviewPlanItem[] {
  const manifestByPath = new Map(manifest.map((item) => [item.relativePath, item]))
  const sizeByPath = new Map<string, number>()
  const destinationCounts = new Map<string, number>()

  for (const item of manifest) {
    const size = item.kind === 'file' ? (item.sizeBytes ?? 0) : manifest.filter((child) => isDescendantPath(child.relativePath, item.relativePath) && child.kind === 'file').reduce((sum, child) => sum + (child.sizeBytes ?? 0), 0)
    sizeByPath.set(item.relativePath, size)
  }

  for (const item of plan) {
    if (item.destinationRelativePath) {
      destinationCounts.set(item.destinationRelativePath, (destinationCounts.get(item.destinationRelativePath) ?? 0) + 1)
    }
  }

  return plan.map((item) => {
    const manifestItem = manifestByPath.get(item.sourceRelativePath)
    const warnings: string[] = []
    const extension = manifestItem?.extension ?? extensionOf(item.sourceRelativePath)
    const size = sizeByPath.get(item.sourceRelativePath) ?? 0

    if (item.destinationRelativePath && destinationCounts.get(item.destinationRelativePath)! > 1) {
      warnings.push('Duplicate destination')
    }

    if (manifestItem?.kind === 'folder' && item.category === 'Assets' && size > 25 * 1024 ** 3) {
      warnings.push('Very large folder classified as Assets')
    }

    if (extension && ['.zip', '.rar', '.7z'].includes(extension)) {
      warnings.push('Archive file needs confirmation')
    }

    if (manifestItem?.kind === 'folder' && item.category === '_Needs Review') {
      warnings.push('Unknown folder')
    }

    if (!item.sourceRelativePath.includes('/') && item.confidence < 0.55) {
      warnings.push('Low confidence root item')
    }

    if (item.destinationRelativePath && !isSafeRelativePath(item.destinationRelativePath)) {
      warnings.push('Unsafe destination path')
    }

    return {
      ...item,
      enabled: item.category !== 'Ignore' && Boolean(item.destinationRelativePath),
      warning: warnings.join(', ') || undefined,
    }
  })
}

export function findDeliverableCandidates(manifest: ManifestItem[], reviewItems: ReviewPlanItem[]): DeliverableCandidate[] {
  const exportPlans = reviewItems.filter((item) => item.enabled && item.category === 'Exports')
  const candidates = new Map<string, DeliverableCandidate>()

  for (const item of manifest) {
    if (item.kind !== 'file') {
      continue
    }

    const extension = item.extension ?? extensionOf(item.name)
    const isExportExtension = Boolean(extension && deliverableExtensions.has(extension))
    const underExports = exportPlans.some((plan) => isDescendantPath(item.relativePath, plan.sourceRelativePath))
    const looseExportLooking = !item.relativePath.includes('/') && isExportExtension && exportWords.test(item.name)

    if (!isExportExtension || (!underExports && !looseExportLooking)) {
      continue
    }

    const likely = likelyDeliverableWords.test(item.name)

    candidates.set(item.relativePath, {
      id: item.id,
      sourceRelativePath: item.relativePath,
      destinationRelativePath: joinRelativePath(['Deliverables', item.name]),
      name: item.name,
      extension,
      sizeBytes: item.sizeBytes,
      likely,
      selected: likely,
    })
  }

  return [...candidates.values()].sort((left, right) => {
    if (left.likely !== right.likely) {
      return left.likely ? -1 : 1
    }

    return left.sourceRelativePath.localeCompare(right.sourceRelativePath)
  })
}

export function buildPreviewTree(projectRootName: string, reviewItems: ReviewPlanItem[], deliverables: DeliverableCandidate[] = []) {
  const paths = new Set<string>()

  for (const item of reviewItems) {
    if (!item.enabled || item.category === 'Ignore' || !item.destinationRelativePath) {
      continue
    }

    addPath(paths, item.destinationRelativePath)
  }

  for (const item of deliverables) {
    if (item.selected) {
      addPath(paths, item.destinationRelativePath)
    }
  }

  return pathsToTree(projectRootName, [...paths])
}

function addPath(paths: Set<string>, path: string) {
  const parts = path.split('/').filter(Boolean)

  for (let index = 1; index <= parts.length; index += 1) {
    paths.add(parts.slice(0, index).join('/'))
  }
}

function pathsToTree(rootName: string, paths: string[]) {
  const tree = new Map<string, Set<string>>()

  for (const path of paths.sort()) {
    const parts = path.split('/').filter(Boolean)

    for (let index = 0; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join('/')
      const child = parts.slice(0, index + 1).join('/')
      const children = tree.get(parent) ?? new Set<string>()
      children.add(child)
      tree.set(parent, children)
    }
  }

  const lines = [rootName]

  function walk(parent: string, prefix: string) {
    const children = [...(tree.get(parent) ?? [])].sort((left, right) => left.localeCompare(right))

    children.forEach((child, index) => {
      const last = index === children.length - 1
      lines.push(`${prefix}${last ? '└── ' : '├── '}${child.split('/').at(-1)}`)
      walk(child, `${prefix}${last ? '    ' : '│   '}`)
    })
  }

  walk('', '')
  return lines
}
