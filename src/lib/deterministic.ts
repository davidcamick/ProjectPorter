import type { ClassifyResponse, ManifestItem, MoveCategory, MovePlanItem } from '../../shared/types.ts'
import { basenameOf, extensionOf, isDescendantPath, joinRelativePath, splitRelativePath } from './path.ts'

const projectExtensions = new Map<string, { app: string; destination: string }>([
  ['.prproj', { app: 'Premiere', destination: 'Project Files/Premiere' }],
  ['.aep', { app: 'After Effects', destination: 'Project Files/After Effects' }],
  ['.aepx', { app: 'After Effects', destination: 'Project Files/After Effects' }],
  ['.ffx', { app: 'After Effects', destination: 'Project Files/After Effects' }],
  ['.psd', { app: 'Photoshop', destination: 'Project Files/Photoshop' }],
  ['.psb', { app: 'Photoshop', destination: 'Project Files/Photoshop' }],
  ['.ai', { app: 'Illustrator', destination: 'Project Files/Illustrator' }],
  ['.eps', { app: 'Illustrator', destination: 'Project Files/Illustrator' }],
])

const videoExtensions = new Set([
  '.mp4',
  '.mov',
  '.m4v',
  '.avi',
  '.mxf',
  '.r3d',
  '.braw',
  '.arri',
  '.mts',
  '.m2ts',
  '.mpg',
  '.mpeg',
  '.wmv',
])

const audioExtensions = new Set(['.wav', '.mp3', '.aac', '.aif', '.aiff', '.m4a', '.flac', '.ogg'])
const imageExtensions = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.tif', '.tiff', '.heic', '.avif'])
const fontExtensions = new Set(['.otf', '.ttf', '.woff', '.woff2'])
const lutExtensions = new Set(['.cube', '.3dl', '.look'])
const zipExtensions = new Set(['.zip', '.rar', '.7z'])
const rawPhotoExtensions = new Set(['.arw', '.cr2', '.cr3', '.nef', '.raf', '.dng', '.orf'])

const exportWords = /\b(export|exports|final|finals|master|delivery|deliverable|approved|upload|posted|client|render|renders|draft|v\d+|review|youtube|instagram|tiktok|social|vertical|horizontal)\b/i
const cameraWords = /\b(sony|a7|a7iii|fx3|fx6|canon|c70|r5|r6|blackmagic|bmpcc|gopro|iphone|camera|cam|footage|clip|clips|raw|media|video|videos)\b/i

type ClassificationResult = {
  category: MoveCategory
  destination: string
  confidence: number
  reason: string
  requiresReview: boolean
  suggestedOnly?: boolean
}

function normalizedName(name: string) {
  return name.toLowerCase().replace(/[_-]+/g, ' ').trim()
}

function folderDestination(item: ManifestItem): ClassificationResult {
  const name = normalizedName(item.name)

  if (['project file', 'project files'].includes(name)) {
    return {
      category: 'Project Files',
      destination: 'Project Files',
      confidence: 0.74,
      reason: 'Existing project-files folder.',
      requiresReview: false,
    }
  }

  if (/^(premiere|prproj|adobe premiere|premiere pro)$/.test(name) || /\bpremiere\b/.test(name)) {
    return {
      category: 'Project Files',
      destination: joinRelativePath(['Project Files', 'Premiere', item.name === 'Premiere' ? null : item.name]),
      confidence: 0.92,
      reason: 'Premiere project folder name.',
      requiresReview: false,
    }
  }

  if (/^(after effects|aftereffects|ae|aep)$/.test(name) || /\b(after effects|aftereffects)\b/.test(name)) {
    return {
      category: 'Project Files',
      destination: joinRelativePath(['Project Files', 'After Effects', ['After Effects', 'AE'].includes(item.name) ? null : item.name]),
      confidence: 0.92,
      reason: 'After Effects project folder name.',
      requiresReview: false,
    }
  }

  if (/^(photoshop|psd)$/.test(name)) {
    return {
      category: 'Project Files',
      destination: joinRelativePath(['Project Files', 'Photoshop', item.name === 'Photoshop' ? null : item.name]),
      confidence: 0.9,
      reason: 'Photoshop project folder name.',
      requiresReview: false,
    }
  }

  if (/^(illustrator|ai)$/.test(name)) {
    return {
      category: 'Project Files',
      destination: joinRelativePath(['Project Files', 'Illustrator', item.name === 'Illustrator' ? null : item.name]),
      confidence: 0.9,
      reason: 'Illustrator project folder name.',
      requiresReview: false,
    }
  }

  if (/^(raw|footage|raw flicks|media|clips?|videos?|camera)$/.test(name) || /^(batch|day)\s*\d+/i.test(name) || cameraWords.test(name)) {
    return {
      category: 'Raw',
      destination: item.name.toLowerCase() === 'raw' ? 'Raw' : joinRelativePath(['Raw', item.name]),
      confidence: 0.88,
      reason: 'Existing footage, batch, day, media, or camera grouping.',
      requiresReview: false,
    }
  }

  if (/^(assets?|music|sfx|sound effects|graphics|logos?|fonts?|luts?|overlays?|images?|thumbnails?|cache|adobe cache|media cache)$/.test(name)) {
    return {
      category: 'Assets',
      destination: item.name.toLowerCase() === 'assets' ? 'Assets' : joinRelativePath(['Assets', item.name]),
      confidence: 0.88,
      reason: 'Existing asset/support folder.',
      requiresReview: false,
    }
  }

  if (/^(exports?|finals?|drafts?|renders?|social|instagram|tiktok|youtube|vertical|horizontal|review|v\d+|old exports?)$/.test(name)) {
    return {
      category: 'Exports',
      destination: item.name.toLowerCase() === 'exports' ? 'Exports' : joinRelativePath(['Exports', item.name]),
      confidence: 0.9,
      reason: 'Existing export/render/review folder.',
      requiresReview: false,
    }
  }

  return {
    category: '_Needs Review',
    destination: joinRelativePath(['_Needs Review', item.name]),
    confidence: 0.36,
    reason: 'Unknown folder name; review before moving.',
    requiresReview: true,
  }
}

function fileDestination(item: ManifestItem): ClassificationResult {
  const extension = item.extension ?? extensionOf(item.name)
  const projectInfo = extension ? projectExtensions.get(extension) : null

  if (projectInfo) {
    return {
      category: 'Project Files',
      destination: joinRelativePath([projectInfo.destination, item.name]),
      confidence: 0.96,
      reason: `${projectInfo.app} project/design file extension.`,
      requiresReview: false,
    }
  }

  if (extension && zipExtensions.has(extension)) {
    return {
      category: '_Needs Review',
      destination: joinRelativePath(['_Needs Review', item.name]),
      confidence: 0.52,
      reason: 'Archive files can be deliverables or source packages; review required.',
      requiresReview: true,
    }
  }

  if (extension && (videoExtensions.has(extension) || rawPhotoExtensions.has(extension))) {
    if (exportWords.test(item.name)) {
      return {
        category: 'Exports',
        destination: joinRelativePath(['Exports', '_Loose Exports', item.name]),
        confidence: 0.82,
        reason: 'Loose root video file has export/final/render wording.',
        requiresReview: false,
        suggestedOnly: /\b(final|master|delivery|deliverable|approved|upload|posted|client)\b/i.test(item.name),
      }
    }

    return {
      category: 'Raw',
      destination: joinRelativePath(['Raw', '_Loose Media', item.name]),
      confidence: cameraWords.test(item.name) ? 0.84 : 0.72,
      reason: 'Loose root video file without final export wording.',
      requiresReview: false,
    }
  }

  if (extension && (audioExtensions.has(extension) || imageExtensions.has(extension) || fontExtensions.has(extension) || lutExtensions.has(extension))) {
    return {
      category: 'Assets',
      destination: joinRelativePath(['Assets', '_Loose Assets', item.name]),
      confidence: 0.76,
      reason: 'Loose root asset/support file.',
      requiresReview: false,
    }
  }

  if (/^\.ds_store$|^thumbs\.db$|^desktop\.ini$/i.test(item.name)) {
    return {
      category: 'Ignore',
      destination: '',
      confidence: 0.98,
      reason: 'System metadata file.',
      requiresReview: false,
    }
  }

  return {
    category: '_Needs Review',
    destination: joinRelativePath(['_Needs Review', item.name]),
    confidence: 0.34,
    reason: 'Unknown loose file type; review before moving.',
    requiresReview: true,
  }
}

export function detectProjectApps(manifest: ManifestItem[]) {
  const apps = new Set<string>()

  for (const item of manifest) {
    const projectInfo = item.extension ? projectExtensions.get(item.extension) : null
    const name = normalizedName(item.name)

    if (projectInfo) {
      apps.add(projectInfo.app)
    }

    if (/^(premiere|prproj|adobe premiere|premiere pro)$/.test(name)) apps.add('Premiere')
    if (/^(after effects|aftereffects|ae|aep)$/.test(name)) apps.add('After Effects')
    if (/^(photoshop|psd)$/.test(name)) apps.add('Photoshop')
    if (/^(illustrator|ai)$/.test(name)) apps.add('Illustrator')
  }

  return [...apps]
}

export function buildDeterministicClassification(manifest: ManifestItem[]): ClassifyResponse {
  const detectedApps = detectProjectApps(manifest)
  const warnings: string[] = []
  const manifestByPath = new Map(manifest.map((item) => [item.relativePath, item]))

  const rawPlan: MovePlanItem[] = manifest.flatMap((item) => {
    const classification = classifyForProjectShape(item, manifestByPath)
    const rootItem = !item.relativePath.includes('/')
    const importantNestedMove = rootItem ? true : shouldPlanNestedItem(item, classification, manifestByPath)

    if (!importantNestedMove) {
      return []
    }

    if (classification.category === '_Needs Review') {
      warnings.push(`${item.relativePath}: ${classification.reason}`)
    }

    return [
      {
        id: item.id,
        sourceRelativePath: item.relativePath,
        destinationRelativePath: classification.destination,
        category: classification.category,
        confidence: classification.confidence,
        reason: classification.reason,
        requiresReview: classification.requiresReview,
        suggestedOnly: classification.suggestedOnly,
      },
    ]
  })

  return {
    plan: sanitizePlan(rawPlan, manifest),
    detectedApps,
    warnings,
    summary: 'Deterministic classification grouped root-level items and extracted clearly misplaced nested folders/files.',
  }
}

function classifyForProjectShape(item: ManifestItem, manifestByPath: Map<string, ManifestItem>): ClassificationResult {
  if (item.kind === 'folder') {
    return folderDestination(item)
  }

  const baseClassification = fileDestination(item)
  const nearestMatchingFolder = findNearestMatchingFolder(item, baseClassification.category, manifestByPath)

  if (nearestMatchingFolder && shouldPreserveInsideFolder(item, baseClassification, nearestMatchingFolder)) {
    const nestedSuffix = suffixAfterAncestor(item.relativePath, nearestMatchingFolder.item.relativePath)

    return {
      ...baseClassification,
      destination: joinRelativePath([nearestMatchingFolder.classification.destination, nestedSuffix]),
      reason: `${baseClassification.reason} Preserving existing ${nearestMatchingFolder.item.name} grouping.`,
    }
  }

  return baseClassification
}

function shouldPreserveInsideFolder(
  item: ManifestItem,
  classification: ClassificationResult,
  nearestFolder: { item: ManifestItem; classification: ClassificationResult },
) {
  if (classification.category !== nearestFolder.classification.category) {
    return false
  }

  if (classification.category !== 'Project Files') {
    return true
  }

  const projectInfo = item.extension ? projectExtensions.get(item.extension) : null

  if (!projectInfo) {
    return true
  }

  return nearestFolder.classification.destination.startsWith(projectInfo.destination)
}

function shouldPlanNestedItem(
  item: ManifestItem,
  classification: ClassificationResult,
  manifestByPath: Map<string, ManifestItem>,
) {
  if (classification.category === 'Ignore') {
    return false
  }

  if (classification.category === '_Needs Review') {
    return false
  }

  const parent = findNearestClassifiedFolder(item, manifestByPath)

  if (!parent) {
    return true
  }

  const naturalDestination = joinRelativePath([parent.classification.destination, suffixAfterAncestor(item.relativePath, parent.item.relativePath)])

  return naturalDestination !== classification.destination
}

function findNearestMatchingFolder(
  item: ManifestItem,
  category: MoveCategory,
  manifestByPath: Map<string, ManifestItem>,
) {
  return findNearestClassifiedFolder(item, manifestByPath, category)
}

function findNearestClassifiedFolder(
  item: ManifestItem,
  manifestByPath: Map<string, ManifestItem>,
  category?: MoveCategory,
) {
  const parts = splitRelativePath(item.relativePath)
  parts.pop()

  while (parts.length > 0) {
    const ancestorPath = parts.join('/')
    const ancestor = manifestByPath.get(ancestorPath)

    if (ancestor?.kind === 'folder') {
      const classification = folderDestination(ancestor)

      if (classification.category !== '_Needs Review' && classification.category !== 'Ignore' && (!category || classification.category === category)) {
        return { item: ancestor, classification }
      }
    }

    parts.pop()
  }

  return null
}

function suffixAfterAncestor(relativePath: string, ancestorPath: string) {
  const suffix = relativePath.slice(ancestorPath.length).replace(/^\/+/, '')
  return suffix || basenameOf(relativePath)
}

export function sanitizePlan(plan: MovePlanItem[], manifest: ManifestItem[]) {
  const manifestPaths = new Set(manifest.map((item) => item.relativePath))
  const sorted = plan
    .filter((item) => manifestPaths.has(item.sourceRelativePath))
    .sort((a, b) => {
      const depthDelta = b.sourceRelativePath.split('/').length - a.sourceRelativePath.split('/').length
      return depthDelta || a.sourceRelativePath.localeCompare(b.sourceRelativePath)
    })

  return sorted.filter(
    (item) => !sorted.some((parent) => parent.sourceRelativePath !== item.sourceRelativePath && isNaturallyCoveredByPlannedParent(item, parent)),
  )
}

function isNaturallyCoveredByPlannedParent(child: MovePlanItem, parent: MovePlanItem) {
  if (parent.sourceRelativePath === child.sourceRelativePath || !isDescendantPath(child.sourceRelativePath, parent.sourceRelativePath)) {
    return false
  }

  if (!parent.destinationRelativePath || !child.destinationRelativePath) {
    return false
  }

  const suffix = suffixAfterAncestor(child.sourceRelativePath, parent.sourceRelativePath)
  const naturalDestination = joinRelativePath([parent.destinationRelativePath, suffix])

  return child.destinationRelativePath === naturalDestination
}
