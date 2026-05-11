import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ClipboardCheck,
  Database,
  FileCheck2,
  FolderOpen,
  HardDrive,
  Loader2,
  Play,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'
import { classifyResponseSchema } from '../shared/schemas.ts'
import type {
  ApplyLogItem,
  ClassifyResponse,
  DeliverableCandidate,
  ManifestItem,
  MoveCategory,
  ReviewPlanItem,
  ScanTotals,
} from '../shared/types.ts'
import { MOVE_CATEGORIES } from '../shared/types.ts'
import { buildDeterministicClassification, detectProjectApps } from './lib/deterministic.ts'
import {
  copyFile,
  destinationParts,
  getOrCreateDirectoryPath,
  getUniqueName,
  moveDirectoryCopyDelete,
  moveFileCopyDelete,
  pickDestinationDirectory,
  pickSourceDirectory,
  readDirectoryTree,
  scanDirectory,
  type FileCopyProgress,
  type ScanProgress,
  type SourceHandleRegistry,
  writeTextFile,
} from './lib/fileSystem.ts'
import { createMockManifest } from './lib/mockManifest.ts'
import { buildPreviewTree, createReviewItems, finalizeClassification, findDeliverableCandidates } from './lib/plan.ts'
import { generateReportJson, generateReportMarkdown, type OrganizationReport } from './lib/report.ts'
import {
  basenameOf,
  dateFolderPrefix,
  formatBytes,
  formatProjectFolderName,
  isDescendantPath,
  isSafeRelativePath,
  joinRelativePath,
} from './lib/path.ts'

type StepKey = 'folders' | 'details' | 'scan' | 'ai' | 'review' | 'deliverables' | 'apply' | 'done'

type ApplyFeedItem = {
  id: string
  source: string
  destination: string
  action: 'copy' | 'move'
  phase: FileCopyProgress['phase']
  percent: number
  bytesCopied: number
  totalBytes: number
}

const steps: Array<{ key: StepKey; label: string; icon: typeof FolderOpen }> = [
  { key: 'folders', label: 'Folders', icon: FolderOpen },
  { key: 'details', label: 'Details', icon: ClipboardCheck },
  { key: 'scan', label: 'Scan', icon: ScanLine },
  { key: 'ai', label: 'AI Plan', icon: Sparkles },
  { key: 'review', label: 'Review', icon: ClipboardCheck },
  { key: 'deliverables', label: 'Deliverables', icon: FileCheck2 },
  { key: 'apply', label: 'Apply', icon: Play },
  { key: 'done', label: 'Done', icon: Check },
]

const emptyTotals: ScanTotals = { files: 0, folders: 0, sizeBytes: 0 }

function App() {
  const [step, setStep] = useState<StepKey>('folders')
  const [projectName, setProjectName] = useStoredState('project-porter.project-name', '')
  const [projectDate, setProjectDate] = useStoredState('project-porter.project-date', new Date().toISOString().slice(0, 10))
  const [finalFolderName, setFinalFolderName] = useStoredState('project-porter.final-folder-name', '')
  const [folderNameTouched, setFolderNameTouched] = useState(false)
  const [importMode, setImportMode] = useStoredBoolean('project-porter.import-mode', true)
  const [copyDeliverables, setCopyDeliverables] = useStoredBoolean('project-porter.copy-deliverables', false)

  const [sourceHandle, setSourceHandle] = useState<FileSystemDirectoryHandle | null>(null)
  const [destinationHandle, setDestinationHandle] = useState<FileSystemDirectoryHandle | null>(null)
  const [sourceRootName, setSourceRootName] = useState('')
  const [mockMode, setMockMode] = useState(false)
  const [dropMessage, setDropMessage] = useState('')

  const [manifest, setManifest] = useState<ManifestItem[]>([])
  const [registry, setRegistry] = useState<SourceHandleRegistry | null>(null)
  const [totals, setTotals] = useState<ScanTotals>(emptyTotals)
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null)
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState('')

  const [planning, setPlanning] = useState(false)
  const [planSource, setPlanSource] = useState('')
  const [planSummary, setPlanSummary] = useState('')
  const [detectedApps, setDetectedApps] = useState<string[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [reviewItems, setReviewItems] = useState<ReviewPlanItem[]>([])
  const [reviewed, setReviewed] = useState(false)

  const [deliverables, setDeliverables] = useState<DeliverableCandidate[]>([])
  const [applying, setApplying] = useState(false)
  const [applyLogs, setApplyLogs] = useState<ApplyLogItem[]>([])
  const [applyFeed, setApplyFeed] = useState<ApplyFeedItem[]>([])
  const [applyProgress, setApplyProgress] = useState({ current: '', completed: 0, total: 0 })
  const [applyError, setApplyError] = useState('')
  const [reportPath, setReportPath] = useState('')
  const [finalTree, setFinalTree] = useState<string[]>([])

  useEffect(() => {
    if (!folderNameTouched) {
      setFinalFolderName(formatProjectFolderName(projectDate, projectName || sourceRootName || 'Untitled Project'))
    }
  }, [folderNameTouched, projectDate, projectName, setFinalFolderName, sourceRootName])

  const currentStepIndex = steps.findIndex((item) => item.key === step)
  const folderSelectionReady = (mockMode || Boolean(sourceHandle)) && (mockMode || !importMode || Boolean(destinationHandle))
  const detailsReady = folderSelectionReady && Boolean(projectName.trim()) && (!importMode || Boolean(finalFolderName.trim()))
  const scanReady = manifest.length > 0
  const selectedDeliverables = deliverables.filter((item) => item.selected)
  const needsReviewCount = reviewItems.filter((item) => item.category === '_Needs Review' || item.requiresReview || item.warning).length
  const enabledPlanItems = reviewItems.filter((item) => item.enabled && item.category !== 'Ignore' && item.destinationRelativePath)
  const totalPlannedSize = useMemo(() => sumPlannedSize(enabledPlanItems, manifest), [enabledPlanItems, manifest])
  const previewTree = useMemo(
    () => buildPreviewTree(importMode ? finalFolderName : sourceRootName || 'Project Folder', reviewItems, deliverables),
    [deliverables, finalFolderName, importMode, reviewItems, sourceRootName],
  )

  async function selectSourceFolder() {
    const handle = await pickSourceDirectory()
    applySourceFolder(handle)
  }

  async function selectDestinationFolder() {
    const handle = await pickDestinationDirectory()
    setDestinationHandle(handle)
  }

  function applySourceFolder(handle: FileSystemDirectoryHandle) {
    setSourceHandle(handle)
    setSourceRootName(handle.name)
    setMockMode(false)
    setDropMessage('')
    setManifest([])
    setRegistry(null)
    setTotals(emptyTotals)
    setReviewItems([])
    setDeliverables([])
    setReviewed(false)

    if (!projectName.trim()) {
      setProjectName(handle.name)
    }
  }

  async function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    setDropMessage('')

    for (const item of Array.from(event.dataTransfer.items)) {
      const droppedHandle = await item.getAsFileSystemHandle?.()

      if (droppedHandle?.kind === 'directory') {
        applySourceFolder(droppedHandle)
        return
      }
    }

    setDropMessage('Folder drag access was not available. Use the source folder button instead.')
  }

  function loadMockProject() {
    const mock = createMockManifest()
    setMockMode(true)
    setSourceHandle(null)
    setDestinationHandle(null)
    setSourceRootName(mock.rootName)
    setProjectName((value) => value || 'Mock Brand Film')
    setManifest(mock.manifest)
    setRegistry(null)
    setTotals(mock.totals)
    setScanProgress({ ...mock.totals, currentPath: 'Mock manifest loaded' })
    setDetectedApps(detectProjectApps(mock.manifest))
    setScanError('')
    setReviewItems([])
    setDeliverables([])
    setReviewed(false)
    setStep('details')
  }

  async function startScan() {
    if (!sourceHandle) {
      return
    }

    setStep('scan')
    setScanning(true)
    setScanError('')
    setManifest([])
    setReviewItems([])
    setDeliverables([])
    setReviewed(false)
    setScanProgress({ ...emptyTotals, currentPath: 'Starting scan' })

    try {
      const result = await scanDirectory(sourceHandle, setScanProgress)
      setManifest(result.manifest)
      setRegistry(result.registry)
      setTotals(result.totals)
      setDetectedApps(detectProjectApps(result.manifest))
      setScanProgress({ ...result.totals, currentPath: 'Scan complete' })
    } catch (error) {
      setScanError(error instanceof Error ? error.message : 'Could not scan the selected folder.')
    } finally {
      setScanning(false)
    }
  }

  async function createAiPlan() {
    if (!scanReady) {
      return
    }

    setStep('ai')
    setPlanning(true)
    setPlanSource('')
    setPlanSummary('')
    setWarnings([])

    const deterministic = buildDeterministicClassification(manifest)

    try {
      const response = await fetch('/api/classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectName: projectName.trim(),
          sourceRootName,
          manifest,
          deterministicHints: {
            plan: deterministic.plan,
            detectedApps: deterministic.detectedApps,
            warnings: deterministic.warnings,
          },
        }),
      })
      const json: unknown = await response.json()

      if (!response.ok) {
        throw new Error('The local AI endpoint was unavailable.')
      }

      const parsed = classifyResponseSchema.parse(json)
      commitClassification(finalizeClassification(parsed, manifest), manifest, 'OpenAI structured output')
    } catch {
      commitClassification(finalizeClassification(deterministic, manifest), manifest, 'Deterministic fallback')
    } finally {
      setPlanning(false)
      setStep('review')
    }
  }

  function commitClassification(classification: ClassifyResponse, sourceManifest: ManifestItem[], sourceLabel: string) {
    setPlanSource(sourceLabel)
    setPlanSummary(classification.summary)
    setWarnings(classification.warnings)
    setDetectedApps(classification.detectedApps)
    setReviewItems(createReviewItems(classification.plan, sourceManifest))
    setReviewed(false)
  }

  function updateReviewItem(id: string, patch: Partial<ReviewPlanItem>) {
    setReviewItems((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }

  function continueToDeliverables() {
    setReviewed(true)
    setDeliverables(findDeliverableCandidates(manifest, reviewItems))
    setStep('deliverables')
  }

  function updateDeliverable(id: string, patch: Partial<DeliverableCandidate>) {
    setDeliverables((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)))
  }

  async function applyOrganization() {
    if (!reviewed || mockMode || !sourceHandle || !registry || (importMode && !destinationHandle)) {
      return
    }

    setStep('apply')
    setApplying(true)
    setApplyError('')
    setApplyLogs([])
    setApplyFeed([])
    setFinalTree([])
    setReportPath('')

    const logs: ApplyLogItem[] = []
    let projectRootHandle: FileSystemDirectoryHandle | null = null
    let destinationLabel = sourceHandle.name
    let completed = 0

    const selectedDeliverablePaths = new Set(selectedDeliverables.map((item) => item.sourceRelativePath))
    const planOperations = dedupePlanOperations(enabledPlanItems).filter((item) => {
      if (!isSafeRelativePath(item.destinationRelativePath)) {
        return false
      }

      return copyDeliverables || !selectedDeliverablePaths.has(item.sourceRelativePath)
    })
    const totalActions = selectedDeliverables.length + planOperations.length + 2

    function setProgress(current: string) {
      setApplyProgress({ current, completed, total: totalActions })
    }

    function addLog(log: ApplyLogItem) {
      logs.push(log)
      setApplyLogs([...logs])
    }

    function finishLog(id: string, patch: Partial<ApplyLogItem>) {
      const index = logs.findIndex((item) => item.id === id)

      if (index >= 0) {
        logs[index] = { ...logs[index], ...patch }
        setApplyLogs([...logs])
      }
    }

    function makeProgressHandler(operationId: string, action: 'copy' | 'move') {
      return (progress: FileCopyProgress) => {
        const feedId = `${operationId}:${progress.sourcePath}`
        const phaseLabel = progress.phase === 'copying' ? 'Copying' : progress.phase === 'verifying' ? 'Verifying' : 'Copied'

        setApplyProgress({
          current: `${phaseLabel}: ${progress.sourcePath} (${Math.round(progress.percent)}%)`,
          completed,
          total: totalActions,
        })
        setApplyFeed((items) => {
          const nextItem: ApplyFeedItem = {
            id: feedId,
            source: progress.sourcePath,
            destination: progress.destinationPath,
            action,
            phase: progress.phase,
            percent: progress.percent,
            bytesCopied: progress.bytesCopied,
            totalBytes: progress.totalBytes,
          }
          const withoutCurrent = items.filter((item) => item.id !== feedId)
          return [nextItem, ...withoutCurrent].slice(0, 80)
        })
      }
    }

    try {
      if (importMode) {
        const uniqueProjectFolderName = await getUniqueName(destinationHandle!, finalFolderName, 'folder')
        projectRootHandle = await destinationHandle!.getDirectoryHandle(uniqueProjectFolderName, { create: true })
        destinationLabel = `${destinationHandle!.name}/${uniqueProjectFolderName}`
      } else {
        projectRootHandle = sourceHandle
        destinationLabel = sourceHandle.name
      }

      for (const deliverable of selectedDeliverables) {
        const logId = `deliverable:${deliverable.sourceRelativePath}`
        setProgress(`Deliverable: ${deliverable.sourceRelativePath}`)
        addLog({
          id: logId,
          source: deliverable.sourceRelativePath,
          destination: deliverable.destinationRelativePath,
          action: copyDeliverables ? 'copy' : 'move',
          status: 'running',
        })

        const record = registry.get(deliverable.sourceRelativePath)

        if (!record || record.kind !== 'file') {
          throw new Error(`Missing source file handle for ${deliverable.sourceRelativePath}`)
        }

        const deliverablesDirectory = await getOrCreateDirectoryPath(projectRootHandle, ['Deliverables'])
        const destinationName = basenameOf(deliverable.destinationRelativePath)
        const result = copyDeliverables
          ? await copyFile(record.handle as FileSystemFileHandle, deliverablesDirectory, destinationName, {
              sourceRelativePath: deliverable.sourceRelativePath,
              destinationRelativePath: 'Deliverables',
              onProgress: makeProgressHandler(logId, 'copy'),
            })
          : await moveFileCopyDelete(record.handle as FileSystemFileHandle, record.parentHandle, deliverablesDirectory, destinationName, {
              sourceRelativePath: deliverable.sourceRelativePath,
              destinationRelativePath: 'Deliverables',
              onProgress: makeProgressHandler(logId, 'move'),
            })

        completed += 1
        finishLog(logId, {
          status: 'done',
          destination: `Deliverables/${result.destinationName}`,
          message: `${formatBytes(result.sizeBytes)} ${copyDeliverables ? 'copied' : 'moved'}`,
        })
      }

      for (const item of planOperations) {
        const logId = `plan:${item.sourceRelativePath}`
        setProgress(`Organizing: ${item.sourceRelativePath}`)
        addLog({
          id: logId,
          source: item.sourceRelativePath,
          destination: item.destinationRelativePath,
          action: 'move',
          status: 'running',
        })

        if (!importMode && item.sourceRelativePath === item.destinationRelativePath) {
          completed += 1
          finishLog(logId, { action: 'skip', status: 'done', message: 'Already in the requested location.' })
          continue
        }

        if (!importMode && item.destinationRelativePath.startsWith(`${item.sourceRelativePath}/`)) {
          throw new Error(`Refusing to move ${item.sourceRelativePath} into itself.`)
        }

        const record = registry.get(item.sourceRelativePath)

        if (!record) {
          throw new Error(`Missing source handle for ${item.sourceRelativePath}`)
        }

        const { parentParts, destinationName } = destinationParts(item.destinationRelativePath)

        if (!destinationName) {
          completed += 1
          finishLog(logId, { action: 'skip', status: 'done', message: 'No destination path was provided.' })
          continue
        }

        const destinationDirectory = await getOrCreateDirectoryPath(projectRootHandle, parentParts)
        const result =
          record.kind === 'file'
            ? await moveFileCopyDelete(record.handle as FileSystemFileHandle, record.parentHandle, destinationDirectory, destinationName, {
                sourceRelativePath: item.sourceRelativePath,
                destinationRelativePath: parentParts.join('/'),
                onProgress: makeProgressHandler(logId, 'move'),
              })
            : await moveDirectoryCopyDelete(record.handle as FileSystemDirectoryHandle, record.parentHandle, destinationDirectory, destinationName, {
                sourceRelativePath: item.sourceRelativePath,
                destinationRelativePath: item.destinationRelativePath,
                onProgress: makeProgressHandler(logId, 'move'),
              })

        completed += 1
        finishLog(logId, {
          status: 'done',
          destination: [...parentParts, result.destinationName].join('/'),
          message: `${formatBytes(result.sizeBytes)} across ${result.files} file${result.files === 1 ? '' : 's'}`,
        })
      }

      setProgress('Writing reports')
      const tree = await readDirectoryTree(projectRootHandle, 4)
      const report = buildReport(destinationLabel, logs, tree)
      await writeTextFile(projectRootHandle, 'ORGANIZATION_REPORT.json', generateReportJson(report))
      await writeTextFile(projectRootHandle, 'ORGANIZATION_REPORT.md', generateReportMarkdown(report))
      completed += 2
      addLog({
        id: 'report',
        source: 'Project Porter',
        destination: 'ORGANIZATION_REPORT.md / ORGANIZATION_REPORT.json',
        action: 'report',
        status: 'done',
      })
      setApplyProgress({ current: 'Complete', completed, total: totalActions })
      setFinalTree(tree)
      setReportPath(`${destinationLabel}/ORGANIZATION_REPORT.md`)
      setStep('done')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Organization failed.'
      setApplyError(message)
      addLog({
        id: `error:${Date.now()}`,
        source: applyProgress.current || 'Apply',
        destination: '',
        action: 'error',
        status: 'error',
        message,
      })

      if (projectRootHandle) {
        try {
          const tree = await readDirectoryTree(projectRootHandle, 4)
          const report = buildReport(destinationLabel, logs, tree)
          await writeTextFile(projectRootHandle, 'ORGANIZATION_REPORT_FAILED.json', generateReportJson(report))
          await writeTextFile(projectRootHandle, 'ORGANIZATION_REPORT_FAILED.md', generateReportMarkdown(report))
          setFinalTree(tree)
        } catch {
          // The browser may deny report writing after a partial failure; the on-screen log remains available.
        }
      }
    } finally {
      setApplying(false)
    }
  }

  function buildReport(destinationLabel: string, logs: ApplyLogItem[], tree: string[]): OrganizationReport {
    return {
      appName: 'Project Porter',
      createdAt: new Date().toISOString(),
      projectName: projectName.trim(),
      sourceFolder: sourceRootName,
      destinationFolder: destinationLabel,
      mode: importMode ? 'import-to-destination' : 'organize-in-place',
      copyDeliverables,
      totals,
      appliedPlan: enabledPlanItems,
      skippedPlan: reviewItems.filter((item) => !item.enabled || item.category === '_Needs Review' || item.category === 'Ignore'),
      deliverables,
      logs,
      warnings,
      finalTree: tree,
    }
  }

  return (
    <main className="min-h-screen bg-[#f6f6f3] text-stone-950">
      <div className="mx-auto flex min-h-screen w-full max-w-[1480px] flex-col px-4 py-4 sm:px-6 lg:px-8">
        <header className="mb-4 flex flex-col gap-4 rounded-lg border border-stone-200 bg-white/90 px-5 py-4 shadow-sm md:flex-row md:items-center md:justify-between">
          <div>
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-lg bg-stone-950 text-white">
                <HardDrive className="size-5" aria-hidden="true" />
              </div>
              <div>
                <h1 className="text-2xl font-semibold tracking-normal">Project Porter</h1>
                <p className="text-sm text-stone-500">Turn messy finished edits into clean portable project folders.</p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
            <ShieldCheck className="size-4" aria-hidden="true" />
            Media stays in your browser. Only names and metadata are sent to the local API.
          </div>
        </header>

        <Stepper currentStepIndex={currentStepIndex} />

        {step === 'folders' && (
          <section className="grid flex-1 gap-4 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
              <SectionTitle icon={FolderOpen} title="Choose Folders" detail="Select the messy source project and where the organized project should live." />

              <div
                className="mt-5 rounded-lg border border-dashed border-stone-300 bg-stone-50 p-5 text-center transition hover:border-stone-400"
                onDragOver={(event) => event.preventDefault()}
                onDrop={handleDrop}
              >
                <FolderOpen className="mx-auto mb-3 size-9 text-stone-500" aria-hidden="true" />
                <p className="font-medium">Drop a source project folder here</p>
                <p className="mt-1 text-sm text-stone-500">If folder drag access is blocked, use the picker button below.</p>
                {dropMessage && <p className="mt-3 text-sm text-amber-700">{dropMessage}</p>}
              </div>

              <div className="mt-5 grid gap-3 sm:grid-cols-2">
                <button className="btn-primary" type="button" onClick={selectSourceFolder}>
                  <FolderOpen className="size-4" aria-hidden="true" />
                  Select Source Project Folder
                </button>
                <button className="btn-secondary" type="button" onClick={selectDestinationFolder}>
                  <Database className="size-4" aria-hidden="true" />
                  Select Destination Projects Folder
                </button>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <InfoPill label="Source" value={mockMode ? sourceRootName : sourceHandle?.name || 'Not selected'} />
                <InfoPill label="Destination" value={destinationHandle?.name || (importMode ? 'Not selected' : 'Source folder')} />
              </div>

              <button className="btn-ghost mt-4" type="button" onClick={loadMockProject}>
                <Sparkles className="size-4" aria-hidden="true" />
                Load sample mock manifest
              </button>
            </div>

            <div className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
              <SectionTitle icon={Database} title="Destination Mode" detail="Choose whether this job is imported into Projects or cleaned up where it is." />

              <div className="mt-5 space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="choice">
                    <input type="checkbox" checked={!importMode} onChange={() => setImportMode(false)} />
                    <span>Organize in place</span>
                  </label>
                  <label className="choice">
                    <input type="checkbox" checked={importMode} onChange={() => setImportMode(true)} />
                    <span>Import into destination Projects folder</span>
                  </label>
                </div>

                <div className="rounded-lg border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950">
                  <p className="font-medium">Local-first safety model</p>
                  <p className="mt-1 text-sky-800">
                    Project Porter scans names, paths, sizes, extensions, and modified dates. It never reads media contents or sends media files to the backend.
                  </p>
                </div>

                <button className="btn-primary w-full" type="button" disabled={!folderSelectionReady} onClick={() => setStep('details')}>
                  <ArrowRight className="size-4" aria-hidden="true" />
                  Continue to Project Details
                </button>
              </div>
            </div>
          </section>
        )}

        {step === 'details' && (
          <Workspace>
            <div className="grid gap-5 lg:grid-cols-[0.95fr_1.05fr]">
              <div>
                <SectionTitle icon={ClipboardCheck} title="Project Details" detail="Name the organized project before scanning and planning." />
                <div className="mt-5 space-y-4">
                  <Field label="Project Name">
                    <input className="input" value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="Client Brand Film" />
                  </Field>
                  <Field label="Project Date">
                    <input className="input" type="date" value={dateFolderPrefix(projectDate)} onChange={(event) => setProjectDate(event.target.value)} />
                  </Field>
                  {importMode && (
                    <Field label="Final Folder Name">
                      <input
                        className="input"
                        value={finalFolderName}
                        onChange={(event) => {
                          setFolderNameTouched(true)
                          setFinalFolderName(event.target.value)
                        }}
                      />
                    </Field>
                  )}
                </div>
              </div>

              <SummaryCard title="Folder Choices">
                <SummaryRow label="Source" value={mockMode ? sourceRootName : sourceHandle?.name || 'Not selected'} />
                <SummaryRow label="Destination" value={destinationHandle?.name || (importMode ? 'Not selected' : 'Source folder')} />
                <SummaryRow label="Mode" value={importMode ? 'Import into destination Projects folder' : 'Organize in place'} />
                <SummaryRow label="Final folder" value={importMode ? finalFolderName : sourceRootName} />
              </SummaryCard>
            </div>

            <div className="mt-5 flex flex-wrap justify-between gap-3">
              <button className="btn-secondary" type="button" onClick={() => setStep('folders')}>
                Back to Folders
              </button>
              <button className="btn-primary" type="button" disabled={!detailsReady} onClick={mockMode ? () => setStep('scan') : startScan}>
                {mockMode ? (
                  <>
                    <ArrowRight className="size-4" aria-hidden="true" />
                    Continue with Mock Scan
                  </>
                ) : (
                  <>
                    <ScanLine className="size-4" aria-hidden="true" />
                    Scan Source Folder
                  </>
                )}
              </button>
            </div>
          </Workspace>
        )}

        {step === 'scan' && (
          <Workspace>
            <SectionTitle icon={ScanLine} title="Scan" detail="Recursive folder scan with metadata only." />
            <StatsGrid totals={totals} detectedApps={detectedApps} />
            <ProgressPanel
              title={scanning ? 'Scanning project folder' : scanReady ? 'Scan complete' : 'Ready to scan'}
              current={scanProgress?.currentPath ?? 'Waiting'}
              value={scanReady ? 100 : 35}
              active={scanning}
            />
            {scanError && <WarningBox>{scanError}</WarningBox>}
            <ManifestPreview manifest={manifest} />
            <div className="mt-5 flex flex-wrap gap-3">
              {!mockMode && (
                <button className="btn-secondary" type="button" disabled={scanning || !sourceHandle} onClick={startScan}>
                  <RefreshCw className="size-4" aria-hidden="true" />
                  Rescan
                </button>
              )}
              <button className="btn-primary" type="button" disabled={!scanReady || scanning} onClick={createAiPlan}>
                <Sparkles className="size-4" aria-hidden="true" />
                Create AI Organization Plan
              </button>
            </div>
          </Workspace>
        )}

        {step === 'ai' && (
          <Workspace>
            <SectionTitle icon={Sparkles} title="AI Plan" detail="Sending the lightweight manifest to the local Express API." />
            <ProgressPanel title="Building organization plan" current="Classifying folders, exports, assets, and review items" value={65} active={planning} />
            <div className="mt-5 rounded-lg border border-stone-200 bg-stone-50 p-4 text-sm text-stone-600">
              The backend receives the manifest only. If the API key is missing or the request fails, the deterministic classifier takes over automatically.
            </div>
          </Workspace>
        )}

        {step === 'review' && (
          <Workspace wide>
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <SectionTitle icon={ClipboardCheck} title="Review Plan" detail={planSource || planSummary || 'Review every proposed operation before applying.'} />
              <div className="flex flex-wrap gap-2">
                <Badge tone="neutral">{planSource || 'Plan ready'}</Badge>
                {needsReviewCount > 0 && <Badge tone="warning">{needsReviewCount} warnings / review flags</Badge>}
              </div>
            </div>

            {warnings.length > 0 && (
              <div className="mt-4 grid gap-2">
                {warnings.slice(0, 4).map((warning) => (
                  <WarningBox key={warning}>{warning}</WarningBox>
                ))}
              </div>
            )}

            <PlanTable items={reviewItems} onChange={updateReviewItem} />

            <div className="mt-5 grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
              <SummaryCard title="Dry-run Summary">
                <SummaryRow label="Enabled operations" value={String(enabledPlanItems.length)} />
                <SummaryRow label="Estimated moved size" value={formatBytes(totalPlannedSize)} />
                <SummaryRow label="Needs review" value={String(needsReviewCount)} />
                <SummaryRow label="Detected apps" value={detectedApps.join(', ') || 'None'} />
              </SummaryCard>
              <TreePreview title="Final Folder Preview" lines={previewTree} highlightNeedsReview />
            </div>

            <div className="mt-5 flex flex-wrap justify-end gap-3">
              <button className="btn-secondary" type="button" onClick={() => setStep('scan')}>
                Back to Scan
              </button>
              <button className="btn-primary" type="button" onClick={continueToDeliverables}>
                <FileCheck2 className="size-4" aria-hidden="true" />
                Select Deliverables
              </button>
            </div>
          </Workspace>
        )}

        {step === 'deliverables' && (
          <Workspace wide>
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <SectionTitle icon={FileCheck2} title="Select Deliverables" detail="Likely final files are checked for you, but nothing is final until you confirm it here." />
              <label className="choice min-w-72">
                <input type="checkbox" checked={copyDeliverables} onChange={(event) => setCopyDeliverables(event.target.checked)} />
                <span>Copy deliverables instead of moving</span>
              </label>
            </div>

            <DeliverablesTable items={deliverables} onChange={updateDeliverable} />

            <div className="mt-5 grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
              <SummaryCard title="Deliverable Summary">
                <SummaryRow label="Selected" value={String(selectedDeliverables.length)} />
                <SummaryRow label="Mode" value={copyDeliverables ? 'Copy to Deliverables' : 'Move to Deliverables'} />
                <SummaryRow label="Likely finals" value={String(deliverables.filter((item) => item.likely).length)} />
              </SummaryCard>
              <TreePreview title="Updated Folder Preview" lines={previewTree} />
            </div>

            <div className="mt-5 flex flex-wrap justify-end gap-3">
              <button className="btn-secondary" type="button" onClick={() => setStep('review')}>
                Back to Review
              </button>
              <button className="btn-primary" type="button" onClick={() => setStep('apply')}>
                Continue to Apply
              </button>
            </div>
          </Workspace>
        )}

        {step === 'apply' && (
          <Workspace>
            <SectionTitle icon={Play} title="Apply" detail="Final dry-run summary before browser file operations begin." />
            <div className="grid gap-4 lg:grid-cols-2">
              <SummaryCard title="Final Summary">
                <SummaryRow label="Source folder" value={sourceRootName || 'Not selected'} />
                <SummaryRow label="Destination folder" value={importMode ? `${destinationHandle?.name ?? 'Destination'}/${finalFolderName}` : sourceRootName} />
                <SummaryRow label="Moves" value={String(enabledPlanItems.length)} />
                <SummaryRow label="Total size" value={formatBytes(totalPlannedSize)} />
                <SummaryRow label="Deliverables selected" value={String(selectedDeliverables.length)} />
                <SummaryRow label="Needs review count" value={String(needsReviewCount)} />
              </SummaryCard>
              <TreePreview title="Folder Preview" lines={previewTree} highlightNeedsReview />
            </div>

            {mockMode && <WarningBox>Mock mode is preview-only. Select real source and destination folders to apply file operations.</WarningBox>}
            {applyError && <WarningBox>{applyError}</WarningBox>}

            <div className="mt-5 rounded-lg border border-stone-200 bg-stone-50 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-medium">{applying ? 'Applying organization' : 'Ready to apply'}</p>
                  <p className="text-sm text-stone-500">{applyProgress.current || 'No file operation has started.'}</p>
                </div>
                <span className="text-sm text-stone-500">
                  {applyProgress.completed}/{applyProgress.total}
                </span>
              </div>
              <ProgressBar value={applyProgress.total ? (applyProgress.completed / applyProgress.total) * 100 : 0} active={applying} />
            </div>

            <ApplyFileFeed items={applyFeed} />
            <ApplyLog logs={applyLogs} />

            <div className="mt-5 flex flex-wrap justify-end gap-3">
              <button className="btn-secondary" type="button" disabled={applying} onClick={() => setStep('deliverables')}>
                Back to Deliverables
              </button>
              <button className="btn-danger" type="button" disabled={!reviewed || applying || mockMode || !detailsReady} onClick={applyOrganization}>
                {applying ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Play className="size-4" aria-hidden="true" />}
                Apply Organization
              </button>
            </div>
          </Workspace>
        )}

        {step === 'done' && (
          <Workspace>
            <SectionTitle icon={Check} title="Done" detail="The organized project folder and reports are ready." />
            <div className="grid gap-4 lg:grid-cols-[0.85fr_1.15fr]">
              <SummaryCard title="Result">
                <SummaryRow label="Report" value={reportPath} />
                <SummaryRow label="Operations" value={String(applyLogs.filter((item) => item.status === 'done').length)} />
                <SummaryRow label="Review items" value={String(reviewItems.filter((item) => item.category === '_Needs Review' || !item.enabled).length)} />
              </SummaryCard>
              <TreePreview title="Final Project Tree" lines={finalTree.length ? finalTree : previewTree} highlightNeedsReview />
            </div>

            <div className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
              Premiere Pro and After Effects projects may need relinking after files are moved.
            </div>

            <div className="mt-5 flex flex-wrap gap-3">
              <button className="btn-primary" type="button" onClick={() => setStep('folders')}>
                Start Another Project
              </button>
              <button className="btn-secondary" type="button" onClick={() => setStep('review')}>
                Review Plan Again
              </button>
            </div>
          </Workspace>
        )}
      </div>
    </main>
  )
}

function Stepper({ currentStepIndex }: { currentStepIndex: number }) {
  return (
    <nav className="mb-4 overflow-x-auto rounded-lg border border-stone-200 bg-white px-3 py-3 shadow-sm" aria-label="Project Porter steps">
      <ol className="flex min-w-[980px] items-center gap-2">
        {steps.map((stepItem, index) => {
          const Icon = stepItem.icon
          const complete = index < currentStepIndex
          const active = index === currentStepIndex

          return (
            <li key={stepItem.key} className="flex flex-1 items-center gap-2">
              <div
                className={[
                  'flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border px-3 text-sm',
                  active ? 'border-stone-950 bg-stone-950 text-white' : complete ? 'border-emerald-200 bg-emerald-50 text-emerald-950' : 'border-stone-200 bg-stone-50 text-stone-500',
                ].join(' ')}
              >
                <Icon className="size-4 shrink-0" aria-hidden="true" />
                <span className="truncate">{stepItem.label}</span>
              </div>
              {index < steps.length - 1 && <ArrowRight className="size-4 shrink-0 text-stone-300" aria-hidden="true" />}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

function Workspace({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return <section className={`flex-1 rounded-lg border border-stone-200 bg-white p-5 shadow-sm ${wide ? 'overflow-hidden' : ''}`}>{children}</section>
}

function SectionTitle({ icon: Icon, title, detail }: { icon: typeof FolderOpen; title: string; detail: string }) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-stone-100 text-stone-700">
        <Icon className="size-5" aria-hidden="true" />
      </div>
      <div>
        <h2 className="text-lg font-semibold tracking-normal">{title}</h2>
        <p className="text-sm text-stone-500">{detail}</p>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-stone-700">{label}</span>
      {children}
    </label>
  )
}

function InfoPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-stone-200 bg-stone-50 p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-stone-500">{label}</p>
      <p className="mt-1 truncate text-sm font-medium">{value}</p>
    </div>
  )
}

function StatsGrid({ totals, detectedApps }: { totals: ScanTotals; detectedApps: string[] }) {
  return (
    <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard label="Files" value={totals.files.toLocaleString()} />
      <StatCard label="Folders" value={totals.folders.toLocaleString()} />
      <StatCard label="Size" value={formatBytes(totals.sizeBytes)} />
      <StatCard label="Project Apps" value={detectedApps.join(', ') || 'None'} />
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-stone-500">{label}</p>
      <p className="mt-1 text-lg font-semibold">{value}</p>
    </div>
  )
}

function ProgressPanel({ title, current, value, active }: { title: string; current: string; value: number; active: boolean }) {
  return (
    <div className="mt-5 rounded-lg border border-stone-200 bg-stone-50 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="font-medium">{title}</p>
          <p className="mt-1 text-sm text-stone-500">{current}</p>
        </div>
        {active && <Loader2 className="size-5 animate-spin text-stone-500" aria-hidden="true" />}
      </div>
      <ProgressBar value={value} active={active} />
    </div>
  )
}

function ProgressBar({ value, active }: { value: number; active: boolean }) {
  return (
    <div className="mt-4 h-2 overflow-hidden rounded-full bg-stone-200">
      <div className={`h-full rounded-full ${active ? 'bg-sky-600' : 'bg-emerald-600'} transition-all`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  )
}

function WarningBox({ children }: { children: ReactNode }) {
  return (
    <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div>{children}</div>
    </div>
  )
}

function Badge({ children, tone }: { children: ReactNode; tone: 'neutral' | 'warning' }) {
  const className = tone === 'warning' ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-stone-200 bg-stone-50 text-stone-700'

  return <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium ${className}`}>{children}</span>
}

function ManifestPreview({ manifest }: { manifest: ManifestItem[] }) {
  const topLevel = manifest.filter((item) => !item.relativePath.includes('/')).slice(0, 12)

  return (
    <div className="mt-5 overflow-hidden rounded-lg border border-stone-200">
      <div className="border-b border-stone-200 bg-stone-50 px-4 py-3">
        <p className="font-medium">Top-level items</p>
      </div>
      <div className="max-h-72 overflow-auto">
        {topLevel.length === 0 ? (
          <p className="p-4 text-sm text-stone-500">No manifest entries yet.</p>
        ) : (
          <table className="w-full text-left text-sm">
            <tbody>
              {topLevel.map((item) => (
                <tr key={item.id} className="border-b border-stone-100 last:border-b-0">
                  <td className="px-4 py-3 font-medium">{item.name}</td>
                  <td className="px-4 py-3 text-stone-500">{item.kind}</td>
                  <td className="px-4 py-3 text-right text-stone-500">{item.kind === 'file' ? formatBytes(item.sizeBytes) : `${item.childCount ?? 0} children`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

function PlanTable({ items, onChange }: { items: ReviewPlanItem[]; onChange: (id: string, patch: Partial<ReviewPlanItem>) => void }) {
  return (
    <div className="mt-5 overflow-hidden rounded-lg border border-stone-200">
      <div className="max-h-[520px] overflow-auto">
        <table className="w-full min-w-[1120px] text-left text-sm">
          <thead className="sticky top-0 z-10 bg-stone-50 text-xs uppercase tracking-wide text-stone-500">
            <tr>
              <th className="w-12 px-3 py-3">Use</th>
              <th className="px-3 py-3">Source</th>
              <th className="px-3 py-3">Destination</th>
              <th className="px-3 py-3">Category</th>
              <th className="px-3 py-3">Reason</th>
              <th className="px-3 py-3">Confidence</th>
              <th className="px-3 py-3">Warning</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className={`border-t border-stone-100 ${item.category === '_Needs Review' ? 'bg-amber-50/60' : 'bg-white'}`}>
                <td className="px-3 py-3 align-top">
                  <input className="size-4 accent-stone-950" type="checkbox" checked={item.enabled} onChange={(event) => onChange(item.id, { enabled: event.target.checked })} />
                </td>
                <td className="max-w-[220px] px-3 py-3 align-top font-medium">
                  <span className="block truncate" title={item.sourceRelativePath}>
                    {item.sourceRelativePath}
                  </span>
                </td>
                <td className="px-3 py-3 align-top">
                  <input
                    className="input h-9 min-w-[260px]"
                    value={item.destinationRelativePath}
                    onChange={(event) => onChange(item.id, { destinationRelativePath: event.target.value })}
                    disabled={item.category === 'Ignore'}
                  />
                </td>
                <td className="px-3 py-3 align-top">
                  <select
                    className="input h-9 min-w-[150px]"
                    value={item.category}
                    onChange={(event) => onChange(item.id, categoryPatch(event.target.value as MoveCategory, item))}
                  >
                    {MOVE_CATEGORIES.map((category) => (
                      <option key={category} value={category}>
                        {category}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="max-w-[260px] px-3 py-3 align-top text-stone-600">{item.reason}</td>
                <td className="px-3 py-3 align-top">{Math.round(item.confidence * 100)}%</td>
                <td className="max-w-[220px] px-3 py-3 align-top text-amber-800">{item.warning || (item.requiresReview ? 'Requires review' : '')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function categoryPatch(category: MoveCategory, item: ReviewPlanItem): Partial<ReviewPlanItem> {
  if (category === 'Ignore') {
    return { category, enabled: false, destinationRelativePath: '', requiresReview: false }
  }

  if (category === '_Needs Review') {
    return { category, enabled: false, destinationRelativePath: `_Needs Review/${basenameOf(item.sourceRelativePath)}`, requiresReview: true }
  }

  return {
    category,
    enabled: true,
    requiresReview: false,
    destinationRelativePath: `${category}/${basenameOf(item.sourceRelativePath)}`,
  }
}

function DeliverablesTable({ items, onChange }: { items: DeliverableCandidate[]; onChange: (id: string, patch: Partial<DeliverableCandidate>) => void }) {
  return (
    <div className="mt-5 overflow-hidden rounded-lg border border-stone-200">
      <div className="max-h-[430px] overflow-auto">
        <table className="w-full min-w-[920px] text-left text-sm">
          <thead className="sticky top-0 z-10 bg-stone-50 text-xs uppercase tracking-wide text-stone-500">
            <tr>
              <th className="w-12 px-3 py-3">Final</th>
              <th className="px-3 py-3">Filename</th>
              <th className="px-3 py-3">Size</th>
              <th className="px-3 py-3">Extension</th>
              <th className="px-3 py-3">Source Path</th>
              <th className="px-3 py-3">Signal</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td className="px-4 py-5 text-stone-500" colSpan={6}>
                  No export-looking files were found. You can go back and classify export folders manually.
                </td>
              </tr>
            ) : (
              items.map((item) => (
                <tr key={item.id} className="border-t border-stone-100">
                  <td className="px-3 py-3">
                    <input className="size-4 accent-stone-950" type="checkbox" checked={item.selected} onChange={(event) => onChange(item.id, { selected: event.target.checked })} />
                  </td>
                  <td className="px-3 py-3 font-medium">{item.name}</td>
                  <td className="px-3 py-3 text-stone-500">{formatBytes(item.sizeBytes)}</td>
                  <td className="px-3 py-3 text-stone-500">{item.extension ?? '-'}</td>
                  <td className="max-w-[360px] px-3 py-3 text-stone-500">
                    <span className="block truncate" title={item.sourceRelativePath}>
                      {item.sourceRelativePath}
                    </span>
                  </td>
                  <td className="px-3 py-3">{item.likely ? <Badge tone="neutral">Likely final</Badge> : <span className="text-stone-400">Export candidate</span>}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function SummaryCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
      <h3 className="font-semibold">{title}</h3>
      <div className="mt-3 divide-y divide-stone-200">{children}</div>
    </div>
  )
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-4 py-2 text-sm">
      <span className="w-36 shrink-0 text-stone-500">{label}</span>
      <span className="min-w-0 break-words font-medium">{value || '-'}</span>
    </div>
  )
}

function TreePreview({ title, lines, highlightNeedsReview = false }: { title: string; lines: string[]; highlightNeedsReview?: boolean }) {
  return (
    <div className="rounded-lg border border-stone-200 bg-stone-950 p-4 text-white">
      <h3 className="mb-3 font-semibold">{title}</h3>
      <pre className="max-h-80 overflow-auto text-xs leading-6 text-stone-200">
        {lines.length
          ? lines.map((line, index) => (
              <span key={`${line}-${index}`} className={highlightNeedsReview && line.includes('_Needs Review') ? 'block text-amber-300' : 'block'}>
                {line}
              </span>
            ))
          : 'No destination folders yet.'}
      </pre>
    </div>
  )
}

function ApplyLog({ logs }: { logs: ApplyLogItem[] }) {
  return (
    <div className="mt-5 overflow-hidden rounded-lg border border-stone-200">
      <div className="border-b border-stone-200 bg-stone-50 px-4 py-3">
        <p className="font-medium">Live Progress</p>
      </div>
      <div className="max-h-72 overflow-auto">
        {logs.length === 0 ? (
          <p className="p-4 text-sm text-stone-500">No operations yet.</p>
        ) : (
          logs.map((log) => (
            <div key={log.id} className="grid gap-2 border-b border-stone-100 px-4 py-3 text-sm last:border-b-0 md:grid-cols-[120px_1fr_1fr]">
              <span className={log.status === 'error' ? 'font-medium text-red-700' : 'font-medium text-stone-700'}>{log.status}</span>
              <span className="min-w-0 truncate" title={log.source}>
                {log.source}
              </span>
              <span className="min-w-0 truncate text-stone-500" title={log.message || log.destination}>
                {log.message || log.destination}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function ApplyFileFeed({ items }: { items: ApplyFeedItem[] }) {
  const active = items.filter((item) => item.phase !== 'done')
  const recent = items.slice(0, 12)

  return (
    <div className="mt-5 overflow-hidden rounded-lg border border-stone-200 bg-white">
      <div className="flex items-center justify-between gap-3 border-b border-stone-200 bg-stone-50 px-4 py-3">
        <div>
          <p className="font-medium">File Feed</p>
          <p className="text-sm text-stone-500">Live per-file copy progress while folders recurse.</p>
        </div>
        <Badge tone={active.length ? 'warning' : 'neutral'}>{active.length ? `${active.length} active` : 'idle'}</Badge>
      </div>
      <div className="max-h-80 overflow-auto">
        {recent.length === 0 ? (
          <p className="p-4 text-sm text-stone-500">File-level progress will appear here once copying starts.</p>
        ) : (
          recent.map((item) => (
            <div key={item.id} className="border-b border-stone-100 px-4 py-3 last:border-b-0">
              <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium" title={item.source}>
                    {item.source}
                  </p>
                  <p className="truncate text-xs text-stone-500" title={item.destination}>
                    {item.action === 'copy' ? 'Copying' : 'Moving'} to {item.destination}
                  </p>
                </div>
                <div className="shrink-0 text-sm font-medium text-stone-700">{Math.round(item.percent)}%</div>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-stone-200">
                <div
                  className={`h-full rounded-full ${item.phase === 'done' ? 'bg-emerald-600' : item.phase === 'verifying' ? 'bg-amber-500' : 'bg-sky-600'}`}
                  style={{ width: `${Math.min(100, Math.max(0, item.percent))}%` }}
                />
              </div>
              <div className="mt-1 flex justify-between text-xs text-stone-500">
                <span>{item.phase}</span>
                <span>
                  {formatBytes(item.bytesCopied)} / {formatBytes(item.totalBytes)}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

function useStoredState(key: string, initialValue: string) {
  const [value, setValue] = useState(() => localStorage.getItem(key) ?? initialValue)

  useEffect(() => {
    localStorage.setItem(key, value)
  }, [key, value])

  return [value, setValue] as const
}

function useStoredBoolean(key: string, initialValue: boolean) {
  const [value, setValue] = useState(() => {
    const stored = localStorage.getItem(key)
    return stored ? stored === 'true' : initialValue
  })

  useEffect(() => {
    localStorage.setItem(key, String(value))
  }, [key, value])

  return [value, setValue] as const
}

function sumPlannedSize(items: ReviewPlanItem[], manifest: ManifestItem[]) {
  return items.reduce((total, item) => {
    const matching = manifest.filter((manifestItem) => isDescendantPath(manifestItem.relativePath, item.sourceRelativePath) && manifestItem.kind === 'file')
    return total + matching.reduce((sum, manifestItem) => sum + (manifestItem.sizeBytes ?? 0), 0)
  }, 0)
}

function dedupePlanOperations(items: ReviewPlanItem[]) {
  return [...items]
    .filter((item) => !items.some((parent) => parent.id !== item.id && isNaturallyCoveredByOperation(item, parent)))
    .sort((left, right) => {
      const depthDelta = right.sourceRelativePath.split('/').length - left.sourceRelativePath.split('/').length
      return depthDelta || left.sourceRelativePath.localeCompare(right.sourceRelativePath)
    })
}

function isNaturallyCoveredByOperation(child: ReviewPlanItem, parent: ReviewPlanItem) {
  if (!isDescendantPath(child.sourceRelativePath, parent.sourceRelativePath) || child.sourceRelativePath === parent.sourceRelativePath) {
    return false
  }

  const suffix = child.sourceRelativePath.slice(parent.sourceRelativePath.length).replace(/^\/+/, '')
  const naturalDestination = joinRelativePath([parent.destinationRelativePath, suffix])

  return child.destinationRelativePath === naturalDestination
}

export default App
