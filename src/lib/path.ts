export function extensionOf(name: string) {
  const dotIndex = name.lastIndexOf('.')
  if (dotIndex <= 0 || dotIndex === name.length - 1) {
    return null
  }

  return name.slice(dotIndex).toLowerCase()
}

export function joinRelativePath(parts: Array<string | null | undefined>) {
  return parts
    .filter((part): part is string => Boolean(part && part.trim()))
    .map((part) => part.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/')
}

export function makeManifestId(kind: string, relativePath: string) {
  return `${kind}:${relativePath}`
}

export function safeFolderSegment(value: string) {
  return value
    .trim()
    .replace(/[/:\\?%*"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+$/, 'Project')
    .slice(0, 80)
}

export function dateFolderPrefix(dateValue: string) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateValue)) {
    return dateValue
  }

  return new Date().toISOString().slice(0, 10)
}

export function formatProjectFolderName(projectDate: string, projectName: string) {
  const cleanName = safeFolderSegment(projectName || 'Untitled Project').replace(/\s+/g, '_')
  return `${dateFolderPrefix(projectDate)}_${cleanName}`
}

export function splitRelativePath(relativePath: string) {
  return relativePath.split('/').map((part) => part.trim()).filter(Boolean)
}

export function isSafeRelativePath(relativePath: string) {
  const parts = splitRelativePath(relativePath)
  return (
    Boolean(relativePath) &&
    !relativePath.startsWith('/') &&
    !relativePath.includes('\\') &&
    parts.every((part) => part !== '.' && part !== '..')
  )
}

export function appendCollisionSuffix(name: string, index: number) {
  const ext = extensionOf(name)

  if (!ext) {
    return `${name}__${index}`
  }

  return `${name.slice(0, -ext.length)}__${index}${ext}`
}

export function parentPathOf(relativePath: string) {
  const parts = splitRelativePath(relativePath)
  parts.pop()
  return parts.join('/')
}

export function basenameOf(relativePath: string) {
  const parts = splitRelativePath(relativePath)
  return parts.at(-1) ?? relativePath
}

export function isDescendantPath(childPath: string, parentPath: string) {
  return childPath === parentPath || childPath.startsWith(`${parentPath}/`)
}

export function formatBytes(bytes: number | null | undefined) {
  if (!bytes) {
    return '0 B'
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / 1024 ** index
  return `${value.toFixed(value >= 10 || index === 0 ? 0 : 1)} ${units[index]}`
}
