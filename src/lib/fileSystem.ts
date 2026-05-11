import type { ManifestItem, ScanTotals } from '../../shared/types.ts'
import { appendCollisionSuffix, extensionOf, joinRelativePath, makeManifestId, splitRelativePath } from './path.ts'

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
  onProgress?: (progress: FileCopyProgress) => void
}

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
  let bytesCopied = 0

  options.onProgress?.({
    sourcePath,
    destinationPath,
    fileName: sourceFile.name,
    bytesCopied,
    totalBytes: sourceFile.size,
    percent: sourceFile.size === 0 ? 100 : 0,
    phase: 'copying',
  })

  try {
    const reader = sourceFile.stream().getReader()

    while (true) {
      const { done, value } = await reader.read()

      if (done) {
        break
      }

      await writable.write(value)
      bytesCopied += value.byteLength
      options.onProgress?.({
        sourcePath,
        destinationPath,
        fileName: sourceFile.name,
        bytesCopied,
        totalBytes: sourceFile.size,
        percent: sourceFile.size === 0 ? 100 : Math.min(100, (bytesCopied / sourceFile.size) * 100),
        phase: 'copying',
      })
    }

    await writable.close()
  } catch (error) {
    await writable.abort()
    throw error
  }

  options.onProgress?.({
    sourcePath,
    destinationPath,
    fileName: sourceFile.name,
    bytesCopied: sourceFile.size,
    totalBytes: sourceFile.size,
    percent: 100,
    phase: 'verifying',
  })

  await verifyFileCopy(sourceFileHandle, destinationFileHandle)
  options.onProgress?.({
    sourcePath,
    destinationPath,
    fileName: sourceFile.name,
    bytesCopied: sourceFile.size,
    totalBytes: sourceFile.size,
    percent: 100,
    phase: 'done',
  })

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
