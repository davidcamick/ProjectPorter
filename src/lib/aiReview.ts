import type {
  AiClassifyResponse,
  AiEstimatedTokenRisk,
  AiReviewCandidate,
  AiReviewFileCandidate,
  AiReviewFolderCandidate,
  AiReviewGroupedSummary,
  AiReviewResponse,
  ClassifyResponse,
  CompactAiReviewPacket,
  CompactAiSettings,
  ManifestItem,
  MoveCategory,
  MovePlanItem,
  OrganizationMode,
} from '../../shared/types.ts'
import { MOVE_CATEGORIES } from '../../shared/types.ts'
import { detectProjectApps, sanitizePlan } from './deterministic.ts'
import {
  CANONICAL_TOP_LEVEL_FOLDERS,
  basenameOf,
  canonicalTopLevelFolderName,
  extensionOf,
  isDescendantPath,
  isHiddenSystemPath,
  joinRelativePath,
  normalizeCanonicalDestinationPath,
  normalizePathSegmentForMatching,
  parentPathOf,
  splitRelativePath,
} from './path.ts'

export const defaultAiSettings: CompactAiSettings = {
  maxAiItems: 200,
  maxSampleChildrenPerFolder: 20,
  maxAiPayloadBytes: 300_000,
}

const unknownExtensions = new Set(['.bin', '.dat', '.tmp'])
const archiveExtensions = new Set(['.zip', '.rar', '.7z'])
const sidecarOrCacheExtensions = new Set(['.mxfindex', '.pek', '.cfa', '.ims', '.mcdb', '.sfk', '.xmp'])
const videoExtensions = new Set(['.mp4', '.mov', '.m4v', '.avi', '.mxf', '.r3d', '.braw', '.mts', '.m2ts', '.mpg', '.mpeg', '.wmv'])
const audioExtensions = new Set(['.wav', '.mp3', '.aac', '.aif', '.aiff', '.m4a', '.flac', '.ogg'])
const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.tif', '.tiff', '.heic', '.avif'])
const projectExtensions = new Set(['.prproj', '.aep', '.aepx', '.ffx', '.psd', '.psb', '.ai', '.eps'])
const confusingFolderWords = /\b(misc|stuff|new folder|copy|copies|final maybe|maybe|sort|unsorted|to sort|old)\b/i
const deliverableWords = /(^|[\s._-])(final|master|posted|upload|approved|delivery|deliverable|client)(?=$|[\s._-])/i
const renderWords = /(^|[\s._-])(linked\s*comp|comp|export|render|renders|v\d+|recap|social|instagram|tiktok|youtube|vertical|horizontal)(?=$|[\s._-])/i

type PacketInput = {
  projectName: string
  projectDate: string
  sourceRootName: string
  mode: 'in-place' | 'import'
  organizationMode: OrganizationMode
  manifest: ManifestItem[]
  deterministic: ClassifyResponse
  settings?: Partial<CompactAiSettings>
}

export function buildCompactAiReviewPacket(input: PacketInput): CompactAiReviewPacket {
  const settings = { ...defaultAiSettings, ...input.settings }
  const manifest = input.manifest.filter((item) => !isHiddenSystemPath(item.relativePath))
  const planByPath = new Map(input.deterministic.plan.map((item) => [item.sourceRelativePath, item]))
  const candidates = collectCandidates(manifest, planByPath, settings)
  const groupedSummaries = candidates.length > settings.maxAiItems ? groupCandidates(candidates.slice(settings.maxAiItems), settings) : []
  let selectedCandidates = candidates.slice(0, settings.maxAiItems)
  let packet = makePacket(input, manifest, selectedCandidates, groupedSummaries, settings, candidates.length > settings.maxAiItems)

  if (byteLength(packet) > settings.maxAiPayloadBytes) {
    selectedCandidates = selectedCandidates.map((candidate) =>
      candidate.kind === 'folder'
        ? {
            ...candidate,
            topLevelSampleChildren: candidate.topLevelSampleChildren.slice(0, Math.min(5, settings.maxSampleChildrenPerFolder)),
          }
        : candidate,
    )
    packet = makePacket(input, manifest, selectedCandidates, groupedSummaries, settings, true, [
      'Large project detected. AI will review summaries only.',
    ])
  }

  if (byteLength(packet) > settings.maxAiPayloadBytes) {
    const cappedCandidates = selectedCandidates.slice(0, Math.max(25, Math.floor(settings.maxAiItems / 4)))
    packet = makePacket(input, manifest, cappedCandidates, groupCandidates(selectedCandidates.slice(cappedCandidates.length), settings), settings, true, [
      'Large project detected. AI will review summaries only.',
      'AI payload was trimmed to stay under the configured byte limit.',
    ])
  }

  return {
    ...packet,
    aiEstimatedTokenRisk: estimateTokenRisk(packet),
  }
}

function makePacket(
  input: PacketInput,
  manifest: ManifestItem[],
  candidates: AiReviewCandidate[],
  groupedSummaries: AiReviewGroupedSummary[],
  settings: CompactAiSettings,
  compacted: boolean,
  extraWarnings: string[] = [],
): CompactAiReviewPacket {
  const folderCandidates = candidates.filter((candidate): candidate is AiReviewFolderCandidate => candidate.kind === 'folder')
  const ambiguousItems = candidates.filter((candidate) => candidate.whySentToAi.some((reason) => /confidence|review|unknown|loose|confusing|conflict/i.test(reason)))
  const suspiciousItems = candidates.filter((candidate) => candidate.whySentToAi.some((reason) => /archive|cache|sidecar|canonical|loose root|conflict/i.test(reason)))
  const deliverableCandidates = candidates.filter(
    (candidate): candidate is AiReviewFileCandidate => candidate.kind === 'file' && candidate.whySentToAi.some((reason) => /deliverable/i.test(reason)),
  )

  return {
    projectName: input.projectName,
    projectDate: input.projectDate,
    sourceRootName: input.sourceRootName,
    mode: input.mode,
    organizationMode: input.organizationMode,
    deterministicPlanSummary: summarizePlan(input.deterministic.plan),
    rootFolderSummary: summarizeRoot(manifest),
    detectedApps: input.deterministic.detectedApps,
    folderCandidates,
    ambiguousItems,
    suspiciousItems,
    deliverableCandidates,
    groupedSummaries,
    validationWarningsBeforeApply: input.deterministic.warnings,
    aiSettings: settings,
    aiEstimatedTokenRisk: 'low',
    compacted,
    warnings: [...extraWarnings, ...input.deterministic.warnings.slice(0, 25)],
  }
}

function collectCandidates(manifest: ManifestItem[], planByPath: Map<string, MovePlanItem>, settings: CompactAiSettings) {
  const candidates: AiReviewCandidate[] = []

  for (const item of manifest) {
    const plan = planByPath.get(item.relativePath)

    if (!plan) {
      continue
    }

    const why = candidateReasons(item, plan, manifest)

    if (why.length === 0) {
      continue
    }

    candidates.push(item.kind === 'folder' ? folderCandidate(item, plan, manifest, settings, why) : fileCandidate(item, plan, why))
  }

  return candidates.sort((left, right) => {
    const confidenceDelta = left.deterministicConfidence - right.deterministicConfidence

    if (confidenceDelta !== 0) {
      return confidenceDelta
    }

    return left.relativePath.localeCompare(right.relativePath)
  })
}

function candidateReasons(item: ManifestItem, plan: MovePlanItem, manifest: ManifestItem[]) {
  const reasons: string[] = []
  const extension = item.extension ?? extensionOf(item.name)
  const rootLevel = !item.relativePath.includes('/')
  const name = normalizePathSegmentForMatching(item.name)

  if (plan.confidence < 0.85) reasons.push('Deterministic confidence under 0.85.')
  if (plan.category === '_Needs Review' || plan.requiresReview) reasons.push('Classified as _Needs Review or requires review.')
  if (extension && unknownExtensions.has(extension)) reasons.push('Unknown or generic extension.')
  if (extension && archiveExtensions.has(extension)) reasons.push('Archive can be source package or deliverable.')
  if (item.kind === 'folder' && confusingFolderWords.test(name)) reasons.push('Confusing folder name.')
  if (item.kind === 'file' && extension && videoExtensions.has(extension) && rootLevel) reasons.push('Loose root video could be raw media or an export/render.')
  if (item.kind === 'file' && deliverableWords.test(name)) reasons.push('Possible deliverable; user confirmation required.')
  if (item.kind === 'file' && renderWords.test(name)) reasons.push('Possible render/export item.')
  if (extension && sidecarOrCacheExtensions.has(extension) && (plan.confidence < 0.95 || rootLevel)) reasons.push('Sidecar/cache file should not remain loose.')
  if (rootLevel && plan.category === '_Needs Review') reasons.push('Root-level item would remain loose without review.')
  if (item.kind === 'folder' && rootLevel && canonicalTopLevelFolderName(item.name) && item.name !== canonicalTopLevelFolderName(item.name)) {
    reasons.push('Canonical top-level folder variant should merge without suffix collisions.')
  }
  if (hasParentChildConflict(item, manifest)) reasons.push('Parent/child move conflict risk.')

  return [...new Set(reasons)]
}

function hasParentChildConflict(item: ManifestItem, manifest: ManifestItem[]) {
  if (item.kind !== 'folder') {
    return false
  }

  return manifest.some((child) => child.relativePath !== item.relativePath && isDescendantPath(child.relativePath, item.relativePath))
}

function folderCandidate(
  item: ManifestItem,
  plan: MovePlanItem,
  manifest: ManifestItem[],
  settings: CompactAiSettings,
  whySentToAi: string[],
): AiReviewFolderCandidate {
  const descendants = manifest.filter((candidate) => candidate.relativePath !== item.relativePath && isDescendantPath(candidate.relativePath, item.relativePath))
  const files = descendants.filter((candidate) => candidate.kind === 'file')
  const folders = descendants.filter((candidate) => candidate.kind === 'folder')
  const extensionCounts: Record<string, number> = {}
  let maxDepth = 0

  for (const file of files) {
    const extension = file.extension ?? extensionOf(file.name) ?? '[none]'
    extensionCounts[extension] = (extensionCounts[extension] ?? 0) + 1
  }

  for (const descendant of descendants) {
    maxDepth = Math.max(maxDepth, splitRelativePath(descendant.relativePath).length - splitRelativePath(item.relativePath).length)
  }

  return {
    id: item.id,
    name: item.name,
    relativePath: item.relativePath,
    kind: 'folder',
    childCount: item.childCount ?? immediateChildCount(item.relativePath, manifest),
    totalFileCount: files.length,
    totalFolderCount: folders.length,
    totalSizeBytes: files.reduce((sum, file) => sum + (file.sizeBytes ?? 0), 0),
    extensionCounts,
    topLevelSampleChildren: immediateChildren(item.relativePath, manifest)
      .map((child) => child.name)
      .slice(0, settings.maxSampleChildrenPerFolder),
    detectedAppsInside: detectProjectApps(descendants),
    containsVideo: files.some((file) => Boolean(file.extension && videoExtensions.has(file.extension))),
    containsAudio: files.some((file) => Boolean(file.extension && audioExtensions.has(file.extension))),
    containsProjectFiles: files.some((file) => Boolean(file.extension && projectExtensions.has(file.extension))),
    containsCache: descendants.some((descendant) => /cache|preview|peak files/i.test(descendant.name) || Boolean(descendant.extension && sidecarOrCacheExtensions.has(descendant.extension))),
    containsExports: descendants.some((descendant) => renderWords.test(descendant.name)),
    containsImages: files.some((file) => Boolean(file.extension && imageExtensions.has(file.extension))),
    containsArchives: files.some((file) => Boolean(file.extension && archiveExtensions.has(file.extension))),
    maxDepth,
    deterministicDestination: plan.destinationRelativePath,
    deterministicConfidence: plan.confidence,
    deterministicReason: plan.reason,
    whySentToAi,
  }
}

function fileCandidate(item: ManifestItem, plan: MovePlanItem, whySentToAi: string[]): AiReviewFileCandidate {
  return {
    id: item.id,
    name: item.name,
    relativePath: item.relativePath,
    kind: 'file',
    extension: item.extension ?? extensionOf(item.name),
    sizeBytes: item.sizeBytes,
    modifiedAt: item.modifiedAt,
    deterministicDestination: plan.destinationRelativePath,
    deterministicConfidence: plan.confidence,
    deterministicReason: plan.reason,
    whySentToAi,
  }
}

function immediateChildren(parentPath: string, manifest: ManifestItem[]) {
  const parentDepth = splitRelativePath(parentPath).length

  return manifest.filter((item) => item.relativePath.startsWith(`${parentPath}/`) && splitRelativePath(item.relativePath).length === parentDepth + 1)
}

function immediateChildCount(parentPath: string, manifest: ManifestItem[]) {
  return immediateChildren(parentPath, manifest).length
}

function groupCandidates(candidates: AiReviewCandidate[], settings: CompactAiSettings): AiReviewGroupedSummary[] {
  const groups = new Map<string, AiReviewCandidate[]>()

  for (const candidate of candidates) {
    const extension = candidate.kind === 'file' ? candidate.extension : null
    const parentPath = parentPathOf(candidate.relativePath)
    const pattern = namePattern(candidate.name)
    const key = `${parentPath}::${extension ?? 'folder'}::${pattern}::${candidate.deterministicDestination}`
    groups.set(key, [...(groups.get(key) ?? []), candidate])
  }

  return [...groups.values()].map((items, index) => {
    const first = items[0]
    const confidences = items.map((item) => item.deterministicConfidence)

    return {
      id: `group:${index}:${parentPathOf(first.relativePath)}`,
      kind: 'group',
      parentPath: parentPathOf(first.relativePath),
      extension: first.kind === 'file' ? first.extension : null,
      namePattern: namePattern(first.name),
      count: items.length,
      deterministicDestination: first.deterministicDestination,
      deterministicConfidenceRange: [Math.min(...confidences), Math.max(...confidences)],
      whySentToAi: [...new Set(items.flatMap((item) => item.whySentToAi))],
      sampleNames: items.map((item) => item.name).slice(0, Math.min(10, settings.maxSampleChildrenPerFolder)),
    }
  })
}

function namePattern(name: string) {
  return name.replace(/\d+/g, '#').replace(/[a-f0-9]{8,}/gi, '[hash]').slice(0, 80)
}

function summarizePlan(plan: MovePlanItem[]) {
  const byCategory = Object.fromEntries(MOVE_CATEGORIES.map((category) => [category, 0])) as Record<MoveCategory, number>

  for (const item of plan) {
    byCategory[item.category] += 1
  }

  return {
    totalItems: plan.length,
    enabledItems: plan.filter((item) => item.category !== 'Ignore' && item.category !== '_Needs Review').length,
    needsReviewItems: plan.filter((item) => item.category === '_Needs Review' || item.requiresReview).length,
    byCategory,
    lowConfidenceItems: plan.filter((item) => item.confidence < 0.85).length,
  }
}

function summarizeRoot(manifest: ManifestItem[]) {
  const rootItems = manifest.filter((item) => !item.relativePath.includes('/'))
  const canonicalFoldersPresent = rootItems
    .filter((item) => item.kind === 'folder' && CANONICAL_TOP_LEVEL_FOLDERS.includes(item.name as (typeof CANONICAL_TOP_LEVEL_FOLDERS)[number]))
    .map((item) => item.name)
  const variantCanonicalFolders = rootItems.flatMap((item) => {
    if (item.kind !== 'folder') {
      return []
    }

    const canonicalName = canonicalTopLevelFolderName(item.name)

    return canonicalName && canonicalName !== item.name ? [{ name: item.name, canonicalName, relativePath: item.relativePath }] : []
  })

  return {
    totalRootItems: rootItems.length,
    files: rootItems.filter((item) => item.kind === 'file').length,
    folders: rootItems.filter((item) => item.kind === 'folder').length,
    canonicalFoldersPresent,
    variantCanonicalFolders,
  }
}

function byteLength(value: unknown) {
  return new Blob([JSON.stringify(value)]).size
}

function estimateTokenRisk(packet: CompactAiReviewPacket): AiEstimatedTokenRisk {
  const bytes = byteLength(packet)
  const itemCount =
    packet.folderCandidates.length +
    packet.ambiguousItems.length +
    packet.suspiciousItems.length +
    packet.deliverableCandidates.length +
    packet.groupedSummaries.length

  if (bytes > 220_000 || itemCount > 160) {
    return 'high'
  }

  if (bytes > 100_000 || itemCount > 60) {
    return 'medium'
  }

  return 'low'
}

export function compactPacketItemCount(packet: CompactAiReviewPacket) {
  const ids = new Set<string>()

  for (const collection of [packet.folderCandidates, packet.ambiguousItems, packet.suspiciousItems, packet.deliverableCandidates]) {
    for (const item of collection) {
      ids.add(item.id)
    }
  }

  return ids.size + packet.groupedSummaries.reduce((sum, group) => sum + group.count, 0)
}

export function summarizeAiPacket(packet: CompactAiReviewPacket) {
  return {
    itemCount: compactPacketItemCount(packet),
    folderCandidates: packet.folderCandidates.length,
    ambiguousItems: packet.ambiguousItems.length,
    suspiciousItems: packet.suspiciousItems.length,
    deliverableCandidates: packet.deliverableCandidates.length,
    groupedSummaries: packet.groupedSummaries.length,
    compacted: packet.compacted,
    aiEstimatedTokenRisk: packet.aiEstimatedTokenRisk,
    byteLength: byteLength(packet),
    warnings: packet.warnings,
  }
}

export function applyAiReviewOverrides(
  deterministic: ClassifyResponse,
  aiResponse: AiReviewResponse | AiClassifyResponse,
  manifest: ManifestItem[],
): ClassifyResponse {
  const byId = new Map(deterministic.plan.map((item) => [item.id, item]))
  const warnings = [...deterministic.warnings, ...aiResponse.warnings]

  for (const override of aiResponse.overrides) {
    const original = byId.get(override.id)

    if (!original) {
      warnings.push(`AI returned an override for unknown item ${override.id}; ignored.`)
      continue
    }

    if (override.action === 'keep') {
      byId.set(override.id, {
        ...original,
        aiReviewed: true,
        reason: `${original.reason} AI reviewed and kept this decision: ${override.reason}`,
        confidence: Math.max(original.confidence, override.confidence),
      })
      continue
    }

    if (override.action === 'ignore') {
      byId.set(override.id, {
        ...original,
        category: 'Ignore',
        destinationRelativePath: '',
        requiresReview: false,
        aiReviewed: true,
        confidence: override.confidence,
        reason: `AI review override: ${override.reason}`,
      })
      continue
    }

    if (override.action === 'mark_needs_review') {
      byId.set(override.id, {
        ...original,
        category: '_Needs Review',
        destinationRelativePath: joinRelativePath(['_Needs Review', basenameOf(original.sourceRelativePath)]),
        requiresReview: true,
        aiReviewed: true,
        confidence: override.confidence,
        reason: `AI review marked this for user review: ${override.reason}`,
      })
      continue
    }

    const category = override.category ?? original.category
    const destinationRelativePath = override.destinationRelativePath
      ? normalizeCanonicalDestinationPath(override.destinationRelativePath)
      : normalizeCanonicalDestinationPath(joinRelativePath([category, basenameOf(original.sourceRelativePath)]))

    byId.set(override.id, {
      ...original,
      category,
      destinationRelativePath: category === 'Ignore' ? '' : destinationRelativePath,
      requiresReview: category === '_Needs Review',
      aiReviewed: true,
      confidence: override.confidence,
      reason: `AI review override: ${override.reason}`,
      suggestedOnly: category === 'Deliverables' ? true : original.suggestedOnly,
    })
  }

  return {
    plan: sanitizePlan([...byId.values()], manifest),
    detectedApps: deterministic.detectedApps,
    warnings: [...new Set(warnings)],
    summary: aiResponse.summary || deterministic.summary,
  }
}
