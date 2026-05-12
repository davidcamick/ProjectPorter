import assert from 'node:assert/strict'
import test from 'node:test'
import type { ManifestItem, ScanTotals } from '../shared/types.ts'
import { buildDeterministicClassification } from '../src/lib/deterministic.ts'
import { createReviewItems, findDeliverableCandidates } from '../src/lib/plan.ts'
import { deliverablesAfterPlanOperations, normalizePlanForApply } from '../src/lib/normalization.ts'
import { extensionOf, makeManifestId } from '../src/lib/path.ts'

const now = '2026-05-11T00:00:00.000Z'

function folder(relativePath: string, childCount = 0, sampleChildren: string[] = []): ManifestItem {
  return {
    id: makeManifestId('folder', relativePath),
    name: relativePath.split('/').at(-1) ?? relativePath,
    relativePath,
    kind: 'folder',
    extension: null,
    sizeBytes: null,
    modifiedAt: null,
    childCount,
    sampleChildren,
  }
}

function file(relativePath: string, sizeBytes = 100): ManifestItem {
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

function classify(manifest: ManifestItem[]) {
  const result = buildDeterministicClassification(manifest)
  return new Map(result.plan.map((item) => [item.sourceRelativePath, item]))
}

function totals(manifest: ManifestItem[]): ScanTotals {
  return manifest.reduce(
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
}

test('Fixture A: 2Checks canonical folders, project files, previews, and raw folders', () => {
  const manifest = [
    folder('Assets'),
    folder('Project File', 3, ['2checks afx.aep', '2checks.prproj', 'Adobe Premiere Pro Audio Previews']),
    file('Project File/2checks afx.aep'),
    file('Project File/2checks.prproj'),
    folder('Project File/Adobe Premiere Pro Audio Previews'),
    folder('exports', 1, ['final_master.mp4']),
    file('exports/final_master.mp4'),
    folder('Raw Flicks'),
    folder('Raw Video'),
  ]
  const byPath = classify(manifest)

  assert.ok(!byPath.get('Assets') || byPath.get('Assets')?.destinationRelativePath === 'Assets')
  assert.equal(byPath.get('Project File/2checks afx.aep')?.destinationRelativePath, 'Project Files/After Effects/2checks afx.aep')
  assert.equal(byPath.get('Project File/2checks.prproj')?.destinationRelativePath, 'Project Files/Premiere/2checks.prproj')
  assert.equal(byPath.get('Project File/Adobe Premiere Pro Audio Previews')?.destinationRelativePath, 'Assets/Adobe Premiere Pro Audio Previews')
  assert.equal(byPath.get('exports')?.destinationRelativePath, 'Exports')
  assert.equal(byPath.get('Raw Flicks')?.destinationRelativePath, 'Raw/Raw Flicks')
  assert.equal(byPath.get('Raw Video')?.destinationRelativePath, 'Raw/Raw Video')
  assert.ok([...byPath.values()].every((item) => !item.destinationRelativePath.includes('Exports__2')))

  const reviewItems = createReviewItems([...byPath.values()], manifest)
  const deliverables = findDeliverableCandidates(manifest, reviewItems)
  assert.equal(deliverables.find((item) => item.sourceRelativePath === 'exports/final_master.mp4')?.selected, true)
  assert.deepEqual(totals(manifest), { files: 3, folders: 6, sizeBytes: 300 })
})

test('Fixture B: Recently previews/cache, project files, camera originals, and loose assets', () => {
  const manifest = [
    folder('Adobe Premiere Pro Video Previews'),
    folder('Media Cache'),
    file('recently.prproj'),
    file('recently Linked Comp 02intro.aep'),
    file('C0001.MP4'),
    file('C8025.MP4'),
    file('C8098.MP4.mp4'),
    file('C0328_Dear_huge TD run beautiful shot.MP4.mp4'),
    file('DC_8903_jerseys.MP4.mp4'),
    file('score.mp3'),
    file('voiceover.wav'),
  ]
  const byPath = classify(manifest)

  assert.equal(byPath.get('Adobe Premiere Pro Video Previews')?.destinationRelativePath, 'Assets/Adobe Premiere Pro Video Previews')
  assert.equal(byPath.get('Media Cache')?.destinationRelativePath, 'Assets/Media Cache')
  assert.equal(byPath.get('recently.prproj')?.destinationRelativePath, 'Project Files/Premiere/recently.prproj')
  assert.equal(byPath.get('recently Linked Comp 02intro.aep')?.destinationRelativePath, 'Project Files/After Effects/recently Linked Comp 02intro.aep')
  assert.equal(byPath.get('C0001.MP4')?.destinationRelativePath, 'Raw/C0001.MP4')
  assert.equal(byPath.get('C8025.MP4')?.destinationRelativePath, 'Raw/C8025.MP4')
  assert.equal(byPath.get('C8098.MP4.mp4')?.destinationRelativePath, 'Raw/C8098.MP4.mp4')
  assert.equal(byPath.get('C0328_Dear_huge TD run beautiful shot.MP4.mp4')?.destinationRelativePath, 'Raw/C0328_Dear_huge TD run beautiful shot.MP4.mp4')
  assert.equal(byPath.get('DC_8903_jerseys.MP4.mp4')?.destinationRelativePath, 'Raw/DC_8903_jerseys.MP4.mp4')
  assert.equal(byPath.get('score.mp3')?.destinationRelativePath, 'Assets/score.mp3')
  assert.equal(byPath.get('voiceover.wav')?.destinationRelativePath, 'Assets/voiceover.wav')
  assert.ok([...byPath.values()].every((item) => !item.destinationRelativePath.startsWith('Raw/Media Cache')))
  assert.ok([...byPath.values()].every((item) => !item.destinationRelativePath.startsWith('Project Files/Adobe Premiere Pro Video Previews')))
})

test('Fixture C: VANDY Recap sidecars, linked comp renders, and selected deliverable path updates', () => {
  const manifest = [
    folder('05_VANDY_my footage'),
    folder('Project File', 3, ['revenge afx.aep', 'revenge.prproj', 'Adobe Premiere Pro Audio Previews']),
    file('Project File/revenge afx.aep'),
    file('Project File/revenge.prproj'),
    folder('Project File/Adobe Premiere Pro Audio Previews'),
    folder('Exports', 1, ['V8_Revenge_Vandy.mp4']),
    file('Exports/V8_Revenge_Vandy.mp4', 1_000),
    file('DO_0171.MXF', 2_000),
    file('fb2bca7b-da97-DO_0171.mxfindex'),
    file('revenge Linked Comp 03.mp4', 500),
  ]
  const result = buildDeterministicClassification(manifest)
  const byPath = new Map(result.plan.map((item) => [item.sourceRelativePath, item]))

  assert.equal(byPath.get('05_VANDY_my footage')?.destinationRelativePath, 'Raw/05_VANDY_my footage')
  assert.equal(byPath.get('Project File/revenge afx.aep')?.destinationRelativePath, 'Project Files/After Effects/revenge afx.aep')
  assert.equal(byPath.get('Project File/revenge.prproj')?.destinationRelativePath, 'Project Files/Premiere/revenge.prproj')
  assert.equal(byPath.get('Project File/Adobe Premiere Pro Audio Previews')?.destinationRelativePath, 'Assets/Adobe Premiere Pro Audio Previews')
  assert.ok(!byPath.get('Exports') || byPath.get('Exports')?.destinationRelativePath === 'Exports')
  assert.equal(byPath.get('DO_0171.MXF')?.destinationRelativePath, 'Raw/DO_0171.MXF')
  assert.equal(byPath.get('fb2bca7b-da97-DO_0171.mxfindex')?.destinationRelativePath, 'Assets/_Sidecars/fb2bca7b-da97-DO_0171.mxfindex')
  assert.equal(byPath.get('revenge Linked Comp 03.mp4')?.destinationRelativePath, 'Exports/_Renders/revenge Linked Comp 03.mp4')
  assert.notEqual(byPath.get('revenge Linked Comp 03.mp4')?.category, 'Raw')

  const reviewItems = createReviewItems(result.plan, manifest)
  const normalized = normalizePlanForApply(reviewItems)
  const selected = [
    {
      id: makeManifestId('file', 'Exports/V8_Revenge_Vandy.mp4'),
      sourceRelativePath: 'Exports/V8_Revenge_Vandy.mp4',
      destinationRelativePath: 'Deliverables/V8_Revenge_Vandy.mp4',
      name: 'V8_Revenge_Vandy.mp4',
      extension: '.mp4',
      sizeBytes: 1_000,
      likely: false,
      selected: true,
    },
  ]

  assert.deepEqual(deliverablesAfterPlanOperations(selected, normalized.operations).map((item) => item.sourceRelativePath), [
    'Exports/V8_Revenge_Vandy.mp4',
  ])
})

test('Plan normalizer resolves parent-child destination paths after canonical folder merges', () => {
  const operations = [
    {
      id: makeManifestId('folder', 'exports'),
      sourceRelativePath: 'exports',
      destinationRelativePath: 'Exports',
      category: 'Exports',
      confidence: 0.96,
      reason: 'merge',
      requiresReview: false,
      enabled: true,
      source: 'rules',
    },
  ]
  const selected = [
    {
      id: makeManifestId('file', 'exports/final.mp4'),
      sourceRelativePath: 'exports/final.mp4',
      destinationRelativePath: 'Deliverables/final.mp4',
      name: 'final.mp4',
      extension: '.mp4',
      sizeBytes: 100,
      likely: true,
      selected: true,
    },
  ]

  const normalized = normalizePlanForApply(operations)
  assert.equal(normalized.operations[0].destinationRelativePath, 'Exports')
  assert.deepEqual(deliverablesAfterPlanOperations(selected, normalized.operations).map((item) => item.sourceRelativePath), ['Exports/final.mp4'])
})
