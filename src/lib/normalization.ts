import type { DeliverableCandidate, ManifestItem, MovePlanItem, ReviewPlanItem } from '../../shared/types.ts'
import {
  basenameOf,
  canonicalTopLevelFolderName,
  extensionOf,
  isDescendantPath,
  isHiddenSystemPath,
  isSafeRelativePath,
  joinRelativePath,
  makeManifestId,
  normalizeCanonicalDestinationPath,
  splitRelativePath,
} from './path.ts'

const canonicalSuffixFolder = /^(Project Files|Raw|Assets|Exports|Deliverables)__\d+$/i
const cachePreviewFolder = /^(Adobe Premiere Pro Video Previews|Adobe Premiere Pro Audio Previews|Media Cache|Cache|Peak Files|Preview Files)$/i
const sidecarExtensions = new Set(['.mxfindex', '.pek', '.sfk', '.xmp'])
const cacheExtensions = new Set(['.cfa', '.ims', '.mcdb'])
const renderFileWords = /(^|[\s._-])(linked\s*comp|render|renders|export|v\d+|recap|social|instagram|tiktok|youtube|vertical|horizontal)(?=$|[\s._-])/i
const cameraOriginalWords = /^(c\d{4,}|dc_\d{4,}|do_\d{4,}|mvi_\d{4,}|gopr\d{4,}|g[xs]\d{6,}|dji_\d{4,})/i

export type NormalizedPlanResult = {
  operations: ReviewPlanItem[]
  warnings: string[]
}

export function normalizePlanForApply(items: ReviewPlanItem[]): NormalizedPlanResult {
  const warnings: string[] = []
  const enabled = items
    .filter((item) => item.enabled && item.category !== 'Ignore' && item.destinationRelativePath)
    .map((item) => ({
      ...item,
      source: item.source ?? 'rules',
      destinationRelativePath: normalizeCanonicalDestinationPath(item.destinationRelativePath),
    }))
    .filter((item) => {
      if (!isSafeRelativePath(item.destinationRelativePath)) {
        warnings.push(`${item.sourceRelativePath}: unsafe destination path was skipped.`)
        return false
      }

      return true
    })

  const bySource = new Map<string, ReviewPlanItem>()

  for (const item of enabled) {
    const existing = bySource.get(item.sourceRelativePath)

    if (!existing || item.confidence > existing.confidence) {
      bySource.set(item.sourceRelativePath, item)
    }
  }

  const sorted = [...bySource.values()].sort((left, right) => {
    const depthDelta = right.sourceRelativePath.split('/').length - left.sourceRelativePath.split('/').length
    return depthDelta || left.sourceRelativePath.localeCompare(right.sourceRelativePath)
  })

  const operations = sorted.filter((item) => !sorted.some((parent) => parent.id !== item.id && isNaturallyCoveredByOperation(item, parent)))
  const destinationCounts = new Map<string, number>()

  for (const operation of operations) {
    destinationCounts.set(operation.destinationRelativePath.toLowerCase(), (destinationCounts.get(operation.destinationRelativePath.toLowerCase()) ?? 0) + 1)
  }

  for (const [destination, count] of destinationCounts) {
    if (count > 1) {
      warnings.push(`Multiple items target ${destination}; folder operations will merge and file collisions will receive suffixes.`)
    }
  }

  for (const operation of operations) {
    if (operation.destinationRelativePath.startsWith(`${operation.sourceRelativePath}/`)) {
      warnings.push(`${operation.sourceRelativePath}: destination is inside source and will be skipped at apply time.`)
    }
  }

  return { operations, warnings }
}

export function resolvePathAfterPlanOperations(sourceRelativePath: string, operations: Array<Pick<MovePlanItem, 'sourceRelativePath' | 'destinationRelativePath'>>) {
  const ancestor = operations
    .filter((operation) => operation.destinationRelativePath && isDescendantPath(sourceRelativePath, operation.sourceRelativePath))
    .sort((left, right) => right.sourceRelativePath.length - left.sourceRelativePath.length)[0]

  if (!ancestor) {
    return sourceRelativePath
  }

  const suffix = sourceRelativePath.slice(ancestor.sourceRelativePath.length).replace(/^\/+/, '')
  return normalizeCanonicalDestinationPath(joinRelativePath([ancestor.destinationRelativePath, suffix]))
}

export function deliverablesAfterPlanOperations(deliverables: DeliverableCandidate[], operations: Array<Pick<MovePlanItem, 'sourceRelativePath' | 'destinationRelativePath'>>) {
  return deliverables.map((deliverable) => ({
    ...deliverable,
    sourceRelativePath: resolvePathAfterPlanOperations(deliverable.sourceRelativePath, operations),
  }))
}

export function isNaturallyCoveredByOperation(child: Pick<MovePlanItem, 'sourceRelativePath' | 'destinationRelativePath'>, parent: Pick<MovePlanItem, 'sourceRelativePath' | 'destinationRelativePath'>) {
  if (!isDescendantPath(child.sourceRelativePath, parent.sourceRelativePath) || child.sourceRelativePath === parent.sourceRelativePath) {
    return false
  }

  const suffix = child.sourceRelativePath.slice(parent.sourceRelativePath.length).replace(/^\/+/, '')
  const naturalDestination = normalizeCanonicalDestinationPath(joinRelativePath([parent.destinationRelativePath, suffix]))

  return normalizeCanonicalDestinationPath(child.destinationRelativePath) === naturalDestination
}

export function isCanonicalMergeOperation(operation: Pick<MovePlanItem, 'sourceRelativePath' | 'destinationRelativePath'>) {
  const sourceParts = splitRelativePath(operation.sourceRelativePath)
  const destinationParts = splitRelativePath(operation.destinationRelativePath)

  if (sourceParts.length !== 1 || destinationParts.length !== 1) {
    return false
  }

  const sourceCanonical = canonicalTopLevelFolderName(sourceParts[0])
  return Boolean(sourceCanonical && sourceCanonical === destinationParts[0] && sourceParts[0] !== destinationParts[0])
}

export function buildCleanupPlan(manifest: ManifestItem[]): MovePlanItem[] {
  const plans: MovePlanItem[] = []

  for (const item of manifest) {
    if (isHiddenSystemPath(item.relativePath)) {
      continue
    }

    const sourceParts = splitRelativePath(item.relativePath)
    const extension = item.extension ?? extensionOf(item.name)

    if (item.kind === 'folder') {
      const canonical = canonicalTopLevelFolderName(item.name)

      if (sourceParts.length === 1 && canonical && item.name !== canonical) {
        plans.push(plan(item, canonical, canonical, `Merge ${item.name} into canonical ${canonical}.`))
        continue
      }

      if (sourceParts.length === 1 && canonicalSuffixFolder.test(item.name)) {
        const canonicalFromSuffix = item.name.replace(/__\d+$/i, '')
        plans.push(plan(item, canonicalFromSuffix, canonicalFromSuffix, `Merge duplicate canonical folder ${item.name}.`))
        continue
      }

      if (cachePreviewFolder.test(item.name) && sourceParts[0] === 'Project Files') {
        plans.push(plan(item, 'Assets', joinRelativePath(['Assets', item.name]), 'Move Premiere previews/cache out of Project Files.'))
        continue
      }

      if (cachePreviewFolder.test(item.name) && (sourceParts[0] === 'Assets' || sourceParts.length === 1)) {
        plans.push(plan(item, 'Assets', sourceParts[0] === 'Assets' ? item.relativePath : joinRelativePath(['Assets', item.name]), 'Existing cache/preview folder.'))
        continue
      }

      if (/^media cache$/i.test(item.name) && sourceParts[0] === 'Raw') {
        plans.push(plan(item, 'Assets', 'Assets/Media Cache', 'Move Media Cache out of Raw.'))
        continue
      }
    }

    if (item.kind === 'file' && sourceParts.length === 1 && extension && sidecarExtensions.has(extension)) {
      plans.push(plan(item, 'Assets', joinRelativePath(['Assets', '_Sidecars', item.name]), 'Move loose sidecar file into Assets/_Sidecars.'))
      continue
    }

    if (item.kind === 'file' && sourceParts.length === 1 && extension && cacheExtensions.has(extension)) {
      plans.push(plan(item, 'Assets', joinRelativePath(['Assets', item.name]), 'Move loose cache file into Assets.'))
      continue
    }

    if (item.kind === 'file' && sourceParts.length === 1 && renderFileWords.test(item.name)) {
      plans.push(plan(item, 'Exports', joinRelativePath(['Exports', '_Renders', item.name]), 'Move loose render/linked-comp file into Exports/_Renders.'))
      continue
    }

    if (item.kind === 'file' && sourceParts.length === 1 && extension && ['.mp4', '.mov', '.mxf'].includes(extension) && isCameraOriginalLooseName(item.name)) {
      plans.push(plan(item, 'Raw', joinRelativePath(['Raw', item.name]), 'Move loose camera-original-looking file into Raw.'))
    }
  }

  return plans
}

function isCameraOriginalLooseName(name: string) {
  return cameraOriginalWords.test(name.replace(/\.(mp4|mov|mxf)\.(mp4|mov|mxf)$/i, '.$2'))
}

function plan(item: ManifestItem, category: string, destinationRelativePath: string, reason: string): MovePlanItem {
  return {
    id: makeManifestId(item.kind, item.relativePath),
    sourceRelativePath: item.relativePath,
    destinationRelativePath,
    category: category as MovePlanItem['category'],
    confidence: 0.98,
    reason,
    requiresReview: false,
    source: 'rules',
  }
}

export function selectedDeliverableDestinations(deliverables: DeliverableCandidate[]) {
  return deliverables
    .filter((deliverable) => deliverable.selected)
    .map((deliverable) => normalizeCanonicalDestinationPath(joinRelativePath(['Deliverables', basenameOf(deliverable.destinationRelativePath)])))
}
