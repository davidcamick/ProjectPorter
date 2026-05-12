import type { DeliverableCandidate, ManifestItem, ValidationIssue, ValidationResult } from '../../shared/types.ts'
import { basenameOf, extensionOf, isHiddenSystemPath, joinRelativePath, splitRelativePath } from './path.ts'

const reportFiles = new Set(['ORGANIZATION_REPORT.md', 'ORGANIZATION_REPORT.json', 'CLEANUP_REPORT.md', 'CLEANUP_REPORT.json'])
const oldRootFolders = /^(Project File|project file|Project Files old)$/i
const duplicateCanonicalFolders = /^(Project Files|Raw|Assets|Exports|Deliverables)__\d+$/i
const previewCacheFolder = /^(Adobe Premiere Pro Video Previews|Adobe Premiere Pro Audio Previews|Media Cache|Cache|Peak Files|Preview Files)$/i
const sidecarCacheExtensions = new Set(['.mxfindex', '.pek', '.cfa', '.ims', '.mcdb', '.sfk', '.xmp'])

export function validateOrganizedProject(
  manifest: ManifestItem[],
  selectedDeliverables: DeliverableCandidate[] = [],
  options: { hiddenFilesVisible?: boolean } = {},
): ValidationResult {
  const issues: ValidationIssue[] = []
  const visibleManifest = manifest.filter((item) => !isHiddenSystemPath(item.relativePath))
  const pathSet = new Set(visibleManifest.map((item) => item.relativePath))

  for (const item of visibleManifest) {
    const parts = splitRelativePath(item.relativePath)
    const extension = item.extension ?? extensionOf(item.name)

    if (parts.length === 1 && item.kind === 'file' && !reportFiles.has(item.name)) {
      issues.push(issue('red', 'loose-root-file', item.relativePath, 'Non-hidden loose root file remains after organization.'))
    }

    if (parts.length === 1 && item.kind === 'folder' && oldRootFolders.test(item.name)) {
      issues.push(issue('yellow', 'old-root-folder', item.relativePath, 'Old project-file root folder remains.'))
    }

    if (parts.length === 1 && item.kind === 'folder' && duplicateCanonicalFolders.test(item.name)) {
      issues.push(issue('red', 'canonical-suffix-folder', item.relativePath, 'Duplicate canonical folder suffix remains.'))
    }

    if (item.kind === 'folder' && parts[0] === 'Project Files' && previewCacheFolder.test(item.name)) {
      issues.push(issue('red', 'cache-in-project-files', item.relativePath, 'Cache or preview folder is inside Project Files.'))
    }

    if (item.kind === 'folder' && parts[0] === 'Raw' && /^media cache$/i.test(item.name)) {
      issues.push(issue('red', 'media-cache-in-raw', item.relativePath, 'Media Cache is inside Raw.'))
    }

    if (parts.length === 1 && item.kind === 'file' && extension && sidecarCacheExtensions.has(extension)) {
      issues.push(issue('red', 'sidecar-cache-root-file', item.relativePath, 'Sidecar/cache file remains at the root.'))
    }

    if (!options.hiddenFilesVisible && item.hiddenSystem) {
      issues.push(issue('yellow', 'hidden-file-visible', item.relativePath, 'Hidden/system file is visible in normal UI state.'))
    }
  }

  const selected = selectedDeliverables.filter((deliverable) => deliverable.selected)

  if (selected.length > 0 && !visibleManifest.some((item) => item.kind === 'folder' && item.relativePath === 'Deliverables')) {
    issues.push(issue('red', 'missing-deliverables-folder', 'Deliverables', 'Deliverables folder is missing even though deliverables were selected.'))
  }

  for (const deliverable of selected) {
    const destination = joinRelativePath(['Deliverables', basenameOf(deliverable.destinationRelativePath)])

    if (!pathSet.has(destination)) {
      issues.push(issue('red', 'selected-deliverable-missing', destination, 'Selected deliverable was not found after apply.'))
    }
  }

  const hasRed = issues.some((item) => item.severity === 'red')
  const hasYellow = issues.some((item) => item.severity === 'yellow')

  if (hasRed) {
    return { severity: 'red', message: 'Project has issues to fix', issues }
  }

  if (hasYellow) {
    return { severity: 'yellow', message: 'Project organized with review items', issues }
  }

  return { severity: 'green', message: 'Project is clean', issues }
}

function issue(severity: ValidationIssue['severity'], code: string, path: string, message: string): ValidationIssue {
  return { severity, code, path, message }
}
