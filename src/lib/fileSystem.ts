import type { ManifestItem, ScanTotals } from '../../shared/types.ts'
import { appendCollisionSuffix, extensionOf, isHiddenSystemPath, joinRelativePath, makeManifestId, splitRelativePath } from './path.ts'

export type SourceHandleRecord = {
  handle: FileSystemFileHandle | FileSystemDirectoryHandle
  parentHandle: FileSystemDirectoryHandle
  kind: 'file' | 'folder'
}

export type SourceHandleRegistry = Map<string, SourceHandleRecord>

export type ScanProgress = ScanTotals & {
  currentPath: string
}

export type ScanResult = {
  manifest: ManifestItem[]
  totals: ScanTotals
  registry: SourceHandleRegistry
}

export type CopySummary = {
  files: number
  folders: number
  sizeBytes: number
}

export type OperationResult = {
  destinationName: string
  sizeBytes: number
  files: number
  folders: number
}

export type FileCopyProgress = {
  sourcePath: string
  destinationPath: string
  fileName: string
  bytesCopied: number
  totalBytes: number
  percent: number
  phase: 'copying' | 'verifying' | 'done'
}

export type CopyOptions = {
  sourceRelativePath?: string
  destinationRelativePath?: string
  verifyFileCopy?: boolean
  progressGranularity?: 'adaptive' | 'full' | 'completion'
  onProgress?: (progress: FileCopyProgress) => void
}

const FAST_SINGLE_WRITE_MAX_BYTES = 256 * 1024 * 1024
const COPY_CHUNK_SIZE_BYTES = 512 * 1024 * 1024
const PROGRESS_REPORT_INTERVAL_MS = 250
const PROGRESS_REPORT_PERCENT_DELTA = 1

export async function pickSourceDirectory() {
  return window.showDirectoryPicker({ mode: 'readwrite' })
}

export async function pickDestinationDirectory() {
  return window.showDirectoryPicker({ mode: 'readwrite' })
}

export async function scanDirectory(
  handle: FileSystemDirectoryHandle,
  onProgress?: (progress: ScanProgress) => void,
): Promise<ScanResult> {
  const manifest: ManifestItem[] = []
  const registry: SourceHandleRegistry = new Map()
  const totals: ScanTotals = { files: 0, folders: 0, sizeBytes: 0 }

  async function scanDir(directoryHandle: FileSystemDirectoryHandle, basePath: string) {
    const entries: Array<[string, FileSystemFileHandle | FileSystemDirectoryHandle]> = []

    for await (const [name, childHandle] of directoryHandle.entries()) {
      entries.push([name, childHandle])
    }

    entries.sort(([leftName], [rightName]) => leftName.localeCompare(rightName))

    for (const [name, childHandle] of entries) {
      const relativePath = joinRelativePath([basePath, name])
      registry.set(relativePath, {
        handle: childHandle,
        parentHandle: directoryHandle,
        kind: childHandle.kind === 'directory' ? 'folder' : 'file',
      })

      if (childHandle.kind === 'directory') {
        const childEntries = await readDirectoryEntryNames(childHandle)
        totals.folders += 1
        manifest.push({
          id: makeManifestId('folder', relativePath),
          name,
          relativePath,
          kind: 'folder',
          extension: null,
          sizeBytes: null,
          modifiedAt: null,
          childCount: childEntries.length,
          sampleChildren: childEntries.slice(0, 8),
          hiddenSystem: isHiddenSystemPath(relativePath),
        })
        onProgress?.({ ...totals, currentPath: relativePath })
        await scanDir(childHandle, relativePath)
      } else {
        const file = await childHandle.getFile()
        totals.files += 1
        totals.sizeBytes += file.size
        manifest.push({
          id: makeManifestId('file', relativePath),
          name,
          relativePath,
          kind: 'file',
          extension: extensionOf(name),
          sizeBytes: file.size,
          modifiedAt: new Date(file.lastModified).toISOString(),
          hiddenSystem: isHiddenSystemPath(relativePath),
        })
        onProgress?.({ ...totals, currentPath: relativePath })
      }
    }
  }

  await scanDir(handle, '')
  return { manifest, totals, registry }
}

async function readDirectoryEntryNames(directoryHandle: FileSystemDirectoryHandle) {
  const names: string[] = []

  for await (const [name] of directoryHandle.entries()) {
    names.push(name)
  }

  return names.sort((left, right) => left.localeCompare(right))
}

export async function getOrCreateDirectoryPath(rootHandle: FileSystemDirectoryHandle, pathParts: string[]) {
  let currentHandle = rootHandle

  for (const part of pathParts.filter(Boolean)) {
    currentHandle = await currentHandle.getDirectoryHandle(part, { create: true })
  }

  return currentHandle
}

export async function getUniqueName(
  destinationDirectoryHandle: FileSystemDirectoryHandle,
  requestedName: string,
  kind: 'file' | 'folder',
) {
  let candidate = requestedName
  let index = 2

  while (await entryExists(destinationDirectoryHandle, candidate, kind)) {
    candidate = appendCollisionSuffix(requestedName, index)
    index += 1
  }

  return candidate
}

async function entryExists(directoryHandle: FileSystemDirectoryHandle, name: string, kind: 'file' | 'folder') {
  try {
    if (kind === 'file') {
      await directoryHandle.getFileHandle(name)
    } else {
      await directoryHandle.getDirectoryHandle(name)
    }

    return true
  } catch {
    return false
  }
}

export async function copyFile(
  sourceFileHandle: FileSystemFileHandle,
  destinationDirectoryHandle: FileSystemDirectoryHandle,
  destinationName: string,
  options: CopyOptions = {},
) {
  const uniqueName = await getUniqueName(destinationDirectoryHandle, destinationName, 'file')
  const sourceFile = await sourceFileHandle.getFile()
  const destinationFileHandle = await destinationDirectoryHandle.getFileHandle(uniqueName, { create: true })
  const writable = await destinationFileHandle.createWritable()
  const sourcePath = options.sourceRelativePath ?? sourceFile.name
  const destinationPath = joinRelativePath([options.destinationRelativePath, uniqueName])
  const progressGranularity = options.progressGranularity ?? 'adaptive'
  const verifyCopiedFile = options.verifyFileCopy ?? true
  let bytesCopied = 0
  let lastReportAt = 0
  let lastReportPercent = -1

  function reportProgress(phase: FileCopyProgress['phase'], force = false) {
    if (!options.onProgress) {
      return
    }

    if (progressGranularity === 'completion' && phase !== 'done') {
      return
    }

    if (progressGranularity === 'adaptive' && sourceFile.size <= FAST_SINGLE_WRITE_MAX_BYTES && phase !== 'done') {
      return
    }

    const percent = sourceFile.size === 0 ? 100 : Math.min(100, (bytesCopied / sourceFile.size) * 100)
    const now = performance.now()

    if (
      force ||
      phase !== 'copying' ||
      now - lastReportAt >= PROGRESS_REPORT_INTERVAL_MS ||
      percent - lastReportPercent >= PROGRESS_REPORT_PERCENT_DELTA
    ) {
      lastReportAt = now
      lastReportPercent = percent
      options.onProgress?.({
        sourcePath,
        destinationPath,
        fileName: sourceFile.name,
        bytesCopied,
        totalBytes: sourceFile.size,
        percent,
        phase,
      })
    }
  }

  reportProgress('copying', true)

  try {
    if (!options.onProgress || sourceFile.size <= FAST_SINGLE_WRITE_MAX_BYTES) {
      await writable.write(sourceFile)
      bytesCopied = sourceFile.size
      reportProgress('copying', true)
    } else {
      while (bytesCopied < sourceFile.size) {
        const nextByte = Math.min(bytesCopied + COPY_CHUNK_SIZE_BYTES, sourceFile.size)
        await writable.write(sourceFile.slice(bytesCopied, nextByte))
        bytesCopied = nextByte
        reportProgress('copying')
      }
    }

    await writable.close()
  } catch (error) {
    await writable.abort()
    throw error
  }

  bytesCopied = sourceFile.size
  if (verifyCopiedFile) {
    reportProgress('verifying', true)
    await verifyFileCopy(sourceFileHandle, destinationFileHandle)
  }

  reportProgress('done', true)

  return {
    destinationName: uniqueName,
    sizeBytes: sourceFile.size,
    files: 1,
    folders: 0,
  } satisfies OperationResult
}

export async function copyDirectory(
  sourceDirectoryHandle: FileSystemDirectoryHandle,
  destinationDirectoryHandle: FileSystemDirectoryHandle,
  destinationName = sourceDirectoryHandle.name,
  options: CopyOptions = {},
) {
  const uniqueName = await getUniqueName(destinationDirectoryHandle, destinationName, 'folder')
  const copiedDirectoryHandle = await destinationDirectoryHandle.getDirectoryHandle(uniqueName, { create: true })
  const sourceBasePath = options.sourceRelativePath ?? sourceDirectoryHandle.name
  const destinationBasePath = options.destinationRelativePath ?? uniqueName
  const copiedSummary = await copyDirectoryChildren(sourceDirectoryHandle, copiedDirectoryHandle, sourceBasePath, destinationBasePath, options)
  const sourceSummary = await summarizeDirectory(sourceDirectoryHandle)
  const destinationSummary = await summarizeDirectory(copiedDirectoryHandle)

  if (sourceSummary.files !== destinationSummary.files || sourceSummary.sizeBytes !== destinationSummary.sizeBytes) {
    throw new Error(`Verification failed for folder "${sourceDirectoryHandle.name}". Copied counts or sizes do not match.`)
  }

  return {
    destinationName: uniqueName,
    sizeBytes: copiedSummary.sizeBytes,
    files: copiedSummary.files,
    folders: copiedSummary.folders + 1,
  } satisfies OperationResult
}

export async function copyDirectoryContents(
  sourceDirectoryHandle: FileSystemDirectoryHandle,
  destinationDirectoryHandle: FileSystemDirectoryHandle,
  options: CopyOptions = {},
) {
  return copyDirectoryChildren(
    sourceDirectoryHandle,
    destinationDirectoryHandle,
    options.sourceRelativePath ?? '',
    options.destinationRelativePath ?? '',
    options,
  )
}

async function copyDirectoryChildren(
  sourceDirectoryHandle: FileSystemDirectoryHandle,
  destinationDirectoryHandle: FileSystemDirectoryHandle,
  sourceBasePath: string,
  destinationBasePath: string,
  options: CopyOptions,
) {
  const summary: CopySummary = { files: 0, folders: 0, sizeBytes: 0 }

  for await (const [name, childHandle] of sourceDirectoryHandle.entries()) {
    const childSourcePath = joinRelativePath([sourceBasePath, name])
    const childDestinationPath = joinRelativePath([destinationBasePath, name])

    if (childHandle.kind === 'file') {
      const result = await copyFile(childHandle, destinationDirectoryHandle, name, {
        ...options,
        sourceRelativePath: childSourcePath,
        destinationRelativePath: destinationBasePath,
        verifyFileCopy: false,
        progressGranularity: options.progressGranularity ?? 'adaptive',
      })
      summary.files += result.files
      summary.sizeBytes += result.sizeBytes
    } else {
      const result = await copyDirectory(childHandle, destinationDirectoryHandle, name, {
        ...options,
        sourceRelativePath: childSourcePath,
        destinationRelativePath: childDestinationPath,
      })
      summary.files += result.files
      summary.folders += result.folders
      summary.sizeBytes += result.sizeBytes
    }
  }

  return summary
}

export async function verifyFileCopy(sourceFileHandle: FileSystemFileHandle, destinationFileHandle: FileSystemFileHandle) {
  const [sourceFile, destinationFile] = await Promise.all([sourceFileHandle.getFile(), destinationFileHandle.getFile()])

  if (sourceFile.size !== destinationFile.size) {
    throw new Error(`Verification failed for "${sourceFile.name}". Copied size does not match.`)
  }
}

export async function summarizeDirectory(directoryHandle: FileSystemDirectoryHandle): Promise<CopySummary> {
  const summary: CopySummary = { files: 0, folders: 0, sizeBytes: 0 }

  for await (const [, childHandle] of directoryHandle.entries()) {
    if (childHandle.kind === 'file') {
      const file = await childHandle.getFile()
      summary.files += 1
      summary.sizeBytes += file.size
    } else {
      const nested = await summarizeDirectory(childHandle)
      summary.files += nested.files
      summary.folders += nested.folders + 1
      summary.sizeBytes += nested.sizeBytes
    }
  }

  return summary
}

export async function removeOriginal(
  handle: FileSystemFileHandle | FileSystemDirectoryHandle,
  parentHandle: FileSystemDirectoryHandle,
) {
  // Destructive step: this is only called after copy and verification have completed.
  await parentHandle.removeEntry(handle.name, { recursive: handle.kind === 'directory' })
}

export async function directoryHasEntries(directoryHandle: FileSystemDirectoryHandle) {
  for await (const _entry of directoryHandle.entries()) {
    return true
  }

  return false
}

export async function removeEmptyDirectories(
  directoryHandle: FileSystemDirectoryHandle,
  rootRelativePath = '',
  onRemove?: (relativePath: string) => void,
) {
  const entries: Array<[string, FileSystemFileHandle | FileSystemDirectoryHandle]> = []

  for await (const [name, childHandle] of directoryHandle.entries()) {
    entries.push([name, childHandle])
  }

  entries.sort(([left], [right]) => right.localeCompare(left))

  for (const [name, childHandle] of entries) {
    if (childHandle.kind !== 'directory') {
      continue
    }

    const childPath = joinRelativePath([rootRelativePath, name])
    await removeEmptyDirectories(childHandle, childPath, onRemove)

    if (!(await directoryHasEntries(childHandle))) {
      await directoryHandle.removeEntry(name)
      onRemove?.(childPath)
    }
  }
}

export async function findExistingDirectoryNameCaseInsensitive(directoryHandle: FileSystemDirectoryHandle, requestedName: string) {
  const requested = requestedName.toLowerCase()

  for await (const [name, childHandle] of directoryHandle.entries()) {
    if (childHandle.kind === 'directory' && name.toLowerCase() === requested) {
      return name
    }
  }

  return null
}

export async function moveFileCopyDelete(
  sourceFileHandle: FileSystemFileHandle,
  parentHandle: FileSystemDirectoryHandle,
  destinationDirectoryHandle: FileSystemDirectoryHandle,
  destinationName: string,
  options: CopyOptions = {},
) {
  const result = await copyFile(sourceFileHandle, destinationDirectoryHandle, destinationName, options)
  await removeOriginal(sourceFileHandle, parentHandle)
  return result
}

export async function moveDirectoryCopyDelete(
  sourceDirectoryHandle: FileSystemDirectoryHandle,
  parentHandle: FileSystemDirectoryHandle,
  destinationDirectoryHandle: FileSystemDirectoryHandle,
  destinationName: string,
  options: CopyOptions = {},
) {
  const result = await copyDirectory(sourceDirectoryHandle, destinationDirectoryHandle, destinationName, options)
  await removeOriginal(sourceDirectoryHandle, parentHandle)
  return result
}

export async function mergeDirectoryContentsCopyDelete(
  sourceDirectoryHandle: FileSystemDirectoryHandle,
  parentHandle: FileSystemDirectoryHandle,
  destinationDirectoryHandle: FileSystemDirectoryHandle,
  options: CopyOptions = {},
) {
  const sourceSummary = await summarizeDirectory(sourceDirectoryHandle)
  const copiedSummary = await copyDirectoryContents(sourceDirectoryHandle, destinationDirectoryHandle, options)

  if (sourceSummary.files !== copiedSummary.files || sourceSummary.sizeBytes !== copiedSummary.sizeBytes) {
    throw new Error(`Verification failed for folder "${sourceDirectoryHandle.name}". Merged counts or sizes do not match.`)
  }

  await removeOriginal(sourceDirectoryHandle, parentHandle)

  return {
    destinationName: destinationDirectoryHandle.name,
    sizeBytes: copiedSummary.sizeBytes,
    files: copiedSummary.files,
    folders: copiedSummary.folders,
  } satisfies OperationResult
}

export async function renameDirectoryCopyDelete(
  sourceDirectoryHandle: FileSystemDirectoryHandle,
  parentHandle: FileSystemDirectoryHandle,
  destinationName: string,
  options: CopyOptions = {},
) {
  const tempName = await getUniqueName(parentHandle, `${destinationName}__rename_tmp`, 'folder')
  const tempResult = await copyDirectory(sourceDirectoryHandle, parentHandle, tempName, {
    ...options,
    destinationRelativePath: tempName,
  })
  await removeOriginal(sourceDirectoryHandle, parentHandle)

  const tempHandle = await parentHandle.getDirectoryHandle(tempResult.destinationName)
  const finalResult = await copyDirectory(tempHandle, parentHandle, destinationName, options)
  await removeOriginal(tempHandle, parentHandle)

  return finalResult
}

export async function writeTextFile(directoryHandle: FileSystemDirectoryHandle, fileName: string, content: string) {
  const fileHandle = await directoryHandle.getFileHandle(fileName, { create: true })
  const writable = await fileHandle.createWritable()

  await writable.write(content)
  await writable.close()
}

export async function readDirectoryTree(directoryHandle: FileSystemDirectoryHandle, maxDepth = 4) {
  const lines: string[] = [directoryHandle.name]

  async function walk(currentHandle: FileSystemDirectoryHandle, depth: number, prefix: string) {
    if (depth > maxDepth) {
      return
    }

    const entries: Array<[string, FileSystemFileHandle | FileSystemDirectoryHandle]> = []

    for await (const [name, childHandle] of currentHandle.entries()) {
      entries.push([name, childHandle])
    }

    entries.sort(([leftName, leftHandle], [rightName, rightHandle]) => {
      if (leftHandle.kind !== rightHandle.kind) {
        return leftHandle.kind === 'directory' ? -1 : 1
      }

      return leftName.localeCompare(rightName)
    })

    for (const [index, [name, childHandle]] of entries.entries()) {
      const last = index === entries.length - 1
      const branch = last ? '└── ' : '├── '
      lines.push(`${prefix}${branch}${name}`)

      if (childHandle.kind === 'directory') {
        await walk(childHandle, depth + 1, `${prefix}${last ? '    ' : '│   '}`)
      }
    }
  }

  await walk(directoryHandle, 1, '')
  return lines
}

export function destinationParts(destinationRelativePath: string) {
  const parts = splitRelativePath(destinationRelativePath)
  const destinationName = parts.pop()

  return {
    parentParts: parts,
    destinationName,
  }
}
