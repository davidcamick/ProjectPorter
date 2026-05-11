import type { ManifestItem, ScanTotals } from '../../shared/types.ts'
import { extensionOf, makeManifestId } from './path.ts'

const now = new Date().toISOString()

function folder(relativePath: string, childCount = 0, sampleChildren: string[] = []): ManifestItem {
  return {
    id: makeManifestId('folder', relativePath),
    name: relativePath.split('/').at(-1) ?? relativePath,
    relativePath,
    kind: 'folder',
    extension: null,
    sizeBytes: null,
    modifiedAt: now,
    childCount,
    sampleChildren,
  }
}

function file(relativePath: string, sizeBytes: number): ManifestItem {
  const name = relativePath.split('/').at(-1) ?? relativePath

  return {
    id: makeManifestId('file', relativePath),
    name,
    relativePath,
    kind: 'file',
    extension: extensionOf(name),
    sizeBytes,
    modifiedAt: now,
  }
}

export function createMockManifest(): { manifest: ManifestItem[]; totals: ScanTotals; rootName: string } {
  const manifest: ManifestItem[] = [
    folder('Premiere', 2, ['Brand Film.prproj', 'Auto-Save']),
    file('Premiere/Brand Film.prproj', 14_400_000),
    folder('Premiere/Auto-Save', 1, ['Brand Film Auto-Save.prproj']),
    file('Premiere/Auto-Save/Brand Film Auto-Save.prproj', 13_900_000),
    folder('Footage', 3, ['Day 1', 'Day 2', 'A012_C004.mov']),
    folder('Footage/Day 1', 2, ['A001_C001.mov', 'A001_C002.mov']),
    file('Footage/Day 1/A001_C001.mov', 3_260_000_000),
    file('Footage/Day 1/A001_C002.mov', 2_940_000_000),
    folder('Footage/Day 2', 1, ['A002_C001.mov']),
    file('Footage/Day 2/A002_C001.mov', 3_780_000_000),
    file('Footage/A012_C004.mov', 2_150_000_000),
    folder('Assets', 4, ['Music', 'Graphics', 'Client Logo.png', 'Media Cache']),
    folder('Assets/Music', 1, ['Score.wav']),
    file('Assets/Music/Score.wav', 86_000_000),
    folder('Assets/Graphics', 1, ['Lower Third.psd']),
    file('Assets/Graphics/Lower Third.psd', 49_000_000),
    file('Assets/Client Logo.png', 2_400_000),
    folder('Assets/Media Cache', 0, []),
    folder('Renders', 4, ['Brand_Film_v1.mp4', 'Brand_Film_FINAL_master.mp4', 'Brand_Film_vertical.mp4', 'old']),
    file('Renders/Brand_Film_v1.mp4', 744_000_000),
    file('Renders/Brand_Film_FINAL_master.mp4', 1_180_000_000),
    file('Renders/Brand_Film_vertical.mp4', 640_000_000),
    folder('Renders/old', 1, ['Brand_Film_v0.mp4']),
    file('Renders/old/Brand_Film_v0.mp4', 603_000_000),
    file('thumbnail_final.jpg', 4_200_000),
    file('client_delivery.zip', 1_420_000_000),
    file('A003_C001.MOV', 2_860_000_000),
    folder('Random Notes', 1, ['brief.txt']),
    file('Random Notes/brief.txt', 42_000),
  ]

  const totals = manifest.reduce<ScanTotals>(
    (acc, item) => {
      if (item.kind === 'file') {
        acc.files += 1
        acc.sizeBytes += item.sizeBytes ?? 0
      } else {
        acc.folders += 1
      }

      return acc
    },
    { files: 0, folders: 0, sizeBytes: 0 },
  )

  return { manifest, totals, rootName: 'Mock Messy Brand Film' }
}
