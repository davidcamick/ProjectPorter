import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from 'react'
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ClipboardCheck,
  Database,
  Download,
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
  AiStatus,
  ApplyLogItem,
  ClassifyResponse,
  CompactAiReviewPacket,
  CompactAiSettings,
  DeliverableCandidate,
  ManifestItem,
  MoveCategory,
  OrganizationMode,
  PlanSource,
  ReviewPlanItem,
  ScanTotals,
  ValidationResult,
} from '../shared/types.ts'
import { MOVE_CATEGORIES } from '../shared/types.ts'
import { buildDeterministicClassification, detectProjectApps } from './lib/deterministic.ts'
import {
  copyDirectoryContents,
  copyFile,
  destinationParts,
  findExistingDirectoryNameCaseInsensitive,
  getOrCreateDirectoryPath,
  getUniqueName,
  mergeDirectoryContentsCopyDelete,
  moveDirectoryCopyDelete,
  moveFileCopyDelete,
  pickDestinationDirectory,
  pickSourceDirectory,
  readDirectoryTree,
  renameDirectoryCopyDelete,
  removeOriginal,
  removeEmptyDirectories,
  scanDirectory,
  type FileCopyProgress,
  type ScanProgress,
  type SourceHandleRegistry,
  writeTextFile,
} from './lib/fileSystem.ts'
import { createMockManifest } from './lib/mockManifest.ts'
import { buildPreviewTree, createReviewItems, finalizeClassification, findDeliverableCandidates } from './lib/plan.ts'
import {
  generateCleanupReportJson,
  generateCleanupReportMarkdown,
  generateCompactDebugLogJson,
  generateDebugLogJson,
  generateReportJson,
  generateReportMarkdown,
  type CleanupReport,
  type CompactDebugLog,
  type DebugLog,
  type OrganizationReport,
} from './lib/report.ts'
import {
  basenameOf,
  dateFolderPrefix,
  formatBytes,
  formatProjectFolderName,
  isHiddenSystemPath,
  isDescendantPath,
  safeFolderSegment,
} from './lib/path.ts'
import {
  applyAiReviewOverrides,
  buildCompactAiReviewPacket,
  compactPacketItemCount,
  defaultAiSettings,
  summarizeAiPacket,
} from './lib/aiReview.ts'
import {
  buildCleanupPlan,
  deliverablesAfterPlanOperations,
  isCanonicalMergeOperation,
  normalizePlanForApply,
} from './lib/normalization.ts'
import { validateOrganizedProject } from './lib/validation.ts'

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
  updatedAt: string
}

type ApplyProgressState = {
  current: string
  completed: number
  total: number
  completedFiles: number
  totalFiles: number
  copiedBytes: number
  totalBytes: number
}

type ApplyTimingState = {
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
}

type RuntimeEventLogItem = {
  id: string
  createdAt: string
  level: 'info' | 'warning' | 'error'
  source: string
  message: string
  details?: unknown
}

const emptyApplyProgress: ApplyProgressState = {
  current: '',
  completed: 0,
  total: 0,
  completedFiles: 0,
  totalFiles: 0,
  copiedBytes: 0,
  totalBytes: 0,
}

const emptyAiStatus: AiStatus = {
  organizationMode: 'rules-only',
  backendHealth: null,
  aiEnabled: false,
  aiRequestStarted: null,
  aiRequestCompleted: null,
  aiDurationMs: null,
  aiItemsSentCount: 0,
  aiEstimatedTokenRisk: 'low',
  aiFallbackUsed: false,
  aiFallbackReason: '',
  aiErrorMessage: '',
  model: '',
  responseSummary: '',
  warnings: [],
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
  const [deleteCacheFiles, setDeleteCacheFiles] = useStoredBoolean('project-porter.delete-cache-files', true)
  const [organizationMode, setOrganizationMode] = useStoredOrganizationMode('project-porter.organization-mode', 'rules-only')
  const [showHiddenSystemFiles, setShowHiddenSystemFiles] = useStoredBoolean('project-porter.show-hidden-system-files', false)
  const [aiSettings] = useState<CompactAiSettings>(defaultAiSettings)

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
  const [planSource, setPlanSource] = useState<PlanSource | ''>('')
  const [planSummary, setPlanSummary] = useState('')
  const [detectedApps, setDetectedApps] = useState<string[]>([])
  const [warnings, setWarnings] = useState<string[]>([])
  const [reviewItems, setReviewItems] = useState<ReviewPlanItem[]>([])
  const [reviewed, setReviewed] = useState(false)
  const [aiStatus, setAiStatus] = useState<AiStatus>(emptyAiStatus)
  const [aiReviewPacket, setAiReviewPacket] = useState<CompactAiReviewPacket | null>(null)
  const [aiResponseSummary, setAiResponseSummary] = useState<unknown>(null)

  const [deliverables, setDeliverables] = useState<DeliverableCandidate[]>([])
  const [applying, setApplying] = useState(false)
  const [applyLogs, setApplyLogs] = useState<ApplyLogItem[]>([])
  const [applyFeed, setApplyFeed] = useState<ApplyFeedItem[]>([])
  const [applyFileRecords, setApplyFileRecords] = useState<ApplyFeedItem[]>([])
  const [applyProgress, setApplyProgress] = useState<ApplyProgressState>(emptyApplyProgress)
  const [applyTiming, setApplyTiming] = useState<ApplyTimingState | null>(null)
  const [applyError, setApplyError] = useState('')
  const [reportPath, setReportPath] = useState('')
  const [finalTree, setFinalTree] = useState<string[]>([])
  const [organizedProjectHandle, setOrganizedProjectHandle] = useState<FileSystemDirectoryHandle | null>(null)
  const [debugLogStatus, setDebugLogStatus] = useState('')
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null)
  const [cleanupActions, setCleanupActions] = useState<ApplyLogItem[]>([])
  const [cleanupStatus, setCleanupStatus] = useState('')
  const [runtimeEvents, setRuntimeEvents] = useState<RuntimeEventLogItem[]>([])

  useEffect(() => {
    if (!folderNameTouched) {
      setFinalFolderName(formatProjectFolderName(projectDate, projectName || sourceRootName || 'Untitled Project'))
    }
  }, [folderNameTouched, projectDate, projectName, setFinalFolderName, sourceRootName])

  useEffect(() => {
    function appendRuntimeEvent(event: Omit<RuntimeEventLogItem, 'id' | 'createdAt'>) {
      setRuntimeEvents((events) => [
        ...events.slice(-199),
        {
          ...event,
          id: `${Date.now()}:${Math.random().toString(36).slice(2)}`,
          createdAt: new Date().toISOString(),
        },
      ])
    }

    function handleWindowError(event: ErrorEvent) {
      appendRuntimeEvent({
        level: 'error',
        source: 'window.error',
        message: event.message || 'Unhandled browser error.',
        details: {
          filename: event.filename,
          lineno: event.lineno,
          colno: event.colno,
          stack: event.error instanceof Error ? event.error.stack : undefined,
        },
      })
    }

    function handleUnhandledRejection(event: PromiseRejectionEvent) {
      appendRuntimeEvent({
        level: 'error',
        source: 'window.unhandledrejection',
        message: errorMessage(event.reason),
        details: serializeUnknownError(event.reason),
      })
    }

    window.addEventListener('error', handleWindowError)
    window.addEventListener('unhandledrejection', handleUnhandledRejection)

    return () => {
      window.removeEventListener('error', handleWindowError)
      window.removeEventListener('unhandledrejection', handleUnhandledRejection)
    }
  }, [])

  const currentStepIndex = steps.findIndex((item) => item.key === step)
  const folderSelectionReady = (mockMode || Boolean(sourceHandle)) && (mockMode || !importMode || Boolean(destinationHandle))
  const detailsReady = folderSelectionReady && Boolean(projectName.trim()) && (!importMode || Boolean(finalFolderName.trim()))
  const visibleManifest = useMemo(() => (showHiddenSystemFiles ? manifest : manifest.filter((item) => !isHiddenSystemPath(item.relativePath))), [manifest, showHiddenSystemFiles])
  const planningManifest = useMemo(() => manifest.filter((item) => !isHiddenSystemPath(item.relativePath)), [manifest])
  const scanReady = planningManifest.length > 0
  const selectedDeliverables = deliverables.filter((item) => item.selected)
  const needsReviewCount = reviewItems.filter((item) => item.category === '_Needs Review' || item.requiresReview || item.warning).length
  const enabledPlanItems = reviewItems.filter((item) => item.enabled && item.category !== 'Ignore' && (item.operation === 'delete' || item.destinationRelativePath))
  const totalPlannedSize = useMemo(() => sumPlannedSize(enabledPlanItems, manifest), [enabledPlanItems, manifest])
  const aiCandidatePreview = useMemo(() => {
    if (!scanReady) {
      return null
    }

    const deterministic = buildDeterministicClassification(planningManifest)
    return summarizeAiPacket(
      buildCompactAiReviewPacket({
        projectName: projectName.trim() || sourceRootName || 'Untitled Project',
        projectDate,
        sourceRootName,
        mode: importMode ? 'import' : 'in-place',
        organizationMode,
        manifest: planningManifest,
        deterministic,
        settings: aiSettings,
      }),
    )
  }, [aiSettings, importMode, organizationMode, planningManifest, projectDate, projectName, scanReady, sourceRootName])
  const debugLogBusy = debugLogStatus.startsWith('Preparing') || debugLogStatus.startsWith('Scanning') || debugLogStatus.startsWith('Building')
  const previewTree = useMemo(
    () => buildPreviewTree(importMode ? finalFolderName : sourceRootName || 'Project Folder', reviewItems, deliverables),
    [deliverables, finalFolderName, importMode, reviewItems, sourceRootName],
  )

  async function selectSourceFolder() {
    try {
      const handle = await pickSourceDirectory()
      applySourceFolder(handle)
    } catch (error) {
      if (isAbortError(error)) {
        return
      }

      setDropMessage(error instanceof Error ? error.message : 'Could not open the source folder picker.')
    }
  }

  async function selectDestinationFolder() {
    try {
      const handle = await pickDestinationDirectory()
      setDestinationHandle(handle)
    } catch (error) {
      if (isAbortError(error)) {
        return
      }

      setDropMessage(error instanceof Error ? error.message : 'Could not open the destination folder picker.')
    }
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
    setApplyFileRecords([])
    setApplyTiming(null)
    setFinalTree([])
    setReportPath('')
    setOrganizedProjectHandle(null)
    setDebugLogStatus('')
    setValidationResult(null)
    setCleanupActions([])
    setAiStatus({ ...emptyAiStatus, organizationMode, aiEnabled: organizationMode !== 'rules-only' })
    setAiReviewPacket(null)
    setAiResponseSummary(null)
    setValidationResult(null)
    setCleanupActions([])
    setCleanupStatus('')

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
    setApplyFileRecords([])
    setApplyTiming(null)
    setFinalTree([])
    setReportPath('')
    setOrganizedProjectHandle(null)
    setDebugLogStatus('')
    setAiStatus({ ...emptyAiStatus, organizationMode, aiEnabled: organizationMode !== 'rules-only' })
    setAiReviewPacket(null)
    setAiResponseSummary(null)
    setValidationResult(null)
    setCleanupActions([])
    setCleanupStatus('')
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
    setApplyFileRecords([])
    setApplyTiming(null)
    setFinalTree([])
    setReportPath('')
    setOrganizedProjectHandle(null)
    setDebugLogStatus('')
    setAiStatus({ ...emptyAiStatus, organizationMode, aiEnabled: organizationMode !== 'rules-only' })
    setAiReviewPacket(null)
    setAiResponseSummary(null)
    setValidationResult(null)
    setCleanupActions([])
    setCleanupStatus('')
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

    const deterministic = buildDeterministicClassification(planningManifest)
    const baseStatus: AiStatus = {
      ...emptyAiStatus,
      organizationMode,
      aiEnabled: organizationMode !== 'rules-only',
      model: '',
    }

    setAiStatus(baseStatus)
    setAiReviewPacket(null)
    setAiResponseSummary(null)

    if (mockMode) {
      commitClassification(finalizeClassification(deterministic, planningManifest), planningManifest, 'Mock')
      setPlanning(false)
      setStep('review')
      return
    }

    if (organizationMode === 'rules-only') {
      commitClassification(finalizeClassification(deterministic, planningManifest), planningManifest, 'Smart Rules')
      setAiStatus({
        ...baseStatus,
        responseSummary: 'AI skipped. Smart Rules Only mode uses deterministic local rules.',
      })
      setPlanning(false)
      setStep('review')
      return
    }

    const packet = buildCompactAiReviewPacket({
      projectName: projectName.trim() || sourceRootName || 'Untitled Project',
      projectDate,
      sourceRootName,
      mode: importMode ? 'import' : 'in-place',
      organizationMode,
      manifest: planningManifest,
      deterministic,
      settings: aiSettings,
    })
    const packetSummary = summarizeAiPacket(packet)
    const aiRequestStarted = new Date().toISOString()
    const aiStartedAtMs = performance.now()
    setAiReviewPacket(packet)

    try {
      const backendHealth = await readBackendHealth()

      setAiStatus({
        ...baseStatus,
        backendHealth,
        aiRequestStarted,
        aiItemsSentCount: compactPacketItemCount(packet),
        aiEstimatedTokenRisk: packet.aiEstimatedTokenRisk,
        model: backendHealthModel(backendHealth),
      })

      const response = await fetch('/api/classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(packet),
      })
      const json = await readResponseBody(response)

      if (!response.ok) {
        const message = extractApiErrorMessage(json, response.status) || `AI review failed with HTTP ${response.status}.`
        throw new Error(message)
      }

      const parsed = classifyResponseSchema.parse(json)
      const classification = applyAiReviewOverrides(deterministic, parsed, planningManifest)
      const aiRequestCompleted = new Date().toISOString()
      const aiDurationMs = Math.round(performance.now() - aiStartedAtMs)

      setAiResponseSummary({
        summary: parsed.summary,
        overrides: parsed.overrides.length,
        warnings: parsed.warnings,
        recommendedUserQuestions: parsed.recommendedUserQuestions,
        model: parsed.model,
      })
      setAiStatus({
        ...baseStatus,
        backendHealth,
        aiRequestStarted,
        aiRequestCompleted,
        aiDurationMs,
        aiItemsSentCount: packetSummary.itemCount,
        aiEstimatedTokenRisk: packet.aiEstimatedTokenRisk,
        model: parsed.model ?? backendHealthModel(backendHealth),
        responseSummary: parsed.summary,
        warnings: parsed.warnings,
      })
      commitClassification(finalizeClassification(classification, planningManifest), planningManifest, 'Smart Rules + AI Review')
    } catch (error) {
      const aiRequestCompleted = new Date().toISOString()
      const aiDurationMs = Math.round(performance.now() - aiStartedAtMs)
      const message = error instanceof Error ? error.message : 'AI review failed.'
      const stack = error instanceof Error ? error.stack : undefined
      const backendHealth = await readBackendHealth()

      setAiStatus({
        ...baseStatus,
        backendHealth,
        aiRequestStarted,
        aiRequestCompleted,
        aiDurationMs,
        aiItemsSentCount: packetSummary.itemCount,
        aiEstimatedTokenRisk: packet.aiEstimatedTokenRisk,
        aiFallbackUsed: true,
        aiFallbackReason: message,
        aiErrorMessage: message,
        aiErrorStack: organizationMode === 'force-ai-debug' ? stack : undefined,
        model: backendHealthModel(backendHealth),
      })
      commitClassification(
        {
          ...finalizeClassification(deterministic, planningManifest),
          warnings: [...deterministic.warnings, `AI review failed; Smart Rules were used. Reason: ${message}`],
          summary: `${deterministic.summary} AI review failed; Smart Rules were used.`,
        },
        planningManifest,
        'Smart Rules + AI Review Failed; Used Smart Rules',
      )
    } finally {
      setPlanning(false)
      setStep('review')
    }
  }

  function commitClassification(classification: ClassifyResponse, sourceManifest: ManifestItem[], sourceLabel: PlanSource) {
    setPlanSource(sourceLabel)
    setPlanSummary(classification.summary)
    setWarnings(classification.warnings)
    setDetectedApps(classification.detectedApps)
    setReviewItems(applyCacheDeletionPreference(createReviewItems(classification.plan, sourceManifest), deleteCacheFiles))
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
    setApplyFileRecords([])
    setApplyProgress(emptyApplyProgress)
    const applyStartedAt = new Date()
    const applyStartedAtMs = performance.now()
    setApplyTiming({ startedAt: applyStartedAt.toISOString(), finishedAt: null, durationMs: null })
    setFinalTree([])
    setReportPath('')
    setOrganizedProjectHandle(null)
    setDebugLogStatus('')

    const logs: ApplyLogItem[] = []
    let projectRootHandle: FileSystemDirectoryHandle | null = null
    let destinationLabel = sourceHandle.name
    let completed = 0
    let currentApplyText = ''
    let lastProgressUiUpdate = 0
    let lastFeedUiUpdate = 0
    let copiedBytes = 0
    let completedFiles = 0
    const fileProgressById = new Map<string, ApplyFeedItem>()

    const deleteOperations = enabledPlanItems.filter((item) => item.operation === 'delete')
    const normalizedPlan = normalizePlanForApply(enabledPlanItems.filter((item) => item.operation !== 'delete'))
    const planOperations = normalizedPlan.operations
    const cleanupLogs: ApplyLogItem[] = []
    const workSummary = buildApplyWorkSummary(planOperations, selectedDeliverables, copyDeliverables, planningManifest)
    const totalActions = selectedDeliverables.length + deleteOperations.length + planOperations.length + (importMode ? 1 : 0) + 4

    function setProgress(current: string, force = true) {
      currentApplyText = current
      const now = performance.now()

      if (!force && now - lastProgressUiUpdate < 200) {
        return
      }

      lastProgressUiUpdate = now
      setApplyProgress({
        current,
        completed,
        total: totalActions,
        completedFiles: Math.min(completedFiles, workSummary.totalFiles),
        totalFiles: workSummary.totalFiles,
        copiedBytes: Math.min(copiedBytes, workSummary.totalBytes),
        totalBytes: workSummary.totalBytes,
      })
    }

    function flushFileFeed(force = false) {
      const now = performance.now()

      if (!force && now - lastFeedUiUpdate < 300) {
        return
      }

      lastFeedUiUpdate = now
      setApplyFeed([...fileProgressById.values()].slice(-80).reverse())
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
        const previousItem = fileProgressById.get(feedId)
        const previousBytes = previousItem?.bytesCopied ?? 0
        const nextBytes = Math.max(previousBytes, progress.bytesCopied)
        const nextItem: ApplyFeedItem = {
          id: feedId,
          source: progress.sourcePath,
          destination: progress.destinationPath,
          action,
          phase: progress.phase,
          percent: progress.percent,
          bytesCopied: nextBytes,
          totalBytes: progress.totalBytes,
          updatedAt: new Date().toISOString(),
        }

        copiedBytes += nextBytes - previousBytes

        if (previousItem?.phase !== 'done' && progress.phase === 'done') {
          completedFiles += 1
        }

        fileProgressById.set(feedId, nextItem)
        setProgress(`${phaseLabel}: ${progress.sourcePath} (${Math.round(progress.percent)}%)`, false)
        flushFileFeed(false)
      }
    }

    try {
      let workingRegistry = registry

      if (importMode) {
        const uniqueProjectFolderName = await getUniqueName(destinationHandle!, finalFolderName, 'folder')
        projectRootHandle = await destinationHandle!.getDirectoryHandle(uniqueProjectFolderName, { create: true })
        destinationLabel = `${destinationHandle!.name}/${uniqueProjectFolderName}`
        setOrganizedProjectHandle(projectRootHandle)
        setProgress(`Importing source into ${uniqueProjectFolderName}`)
        const importLogId = 'import:source-copy'
        addLog({
          id: importLogId,
          source: sourceHandle.name,
          destination: destinationLabel,
          action: 'copy',
          status: 'running',
        })
        const importResult = await copyDirectoryContents(sourceHandle, projectRootHandle, {
          sourceRelativePath: '',
          destinationRelativePath: '',
          progressGranularity: 'adaptive',
          onProgress: makeProgressHandler(importLogId, 'copy'),
        })
        completed += 1
        finishLog(importLogId, {
          status: 'done',
          message: `${formatBytes(importResult.sizeBytes)} across ${importResult.files} file${importResult.files === 1 ? '' : 's'} copied before organizing.`,
        })
        const importedScan = await scanDirectory(projectRootHandle)
        workingRegistry = importedScan.registry
      } else {
        projectRootHandle = sourceHandle
        destinationLabel = sourceHandle.name
      }

      setOrganizedProjectHandle(projectRootHandle)

      for (const item of deleteOperations) {
        const logId = `delete:${item.sourceRelativePath}`
        setProgress(`Deleting cache/preview: ${item.sourceRelativePath}`)
        addLog({
          id: logId,
          source: item.sourceRelativePath,
          destination: '',
          action: 'delete',
          status: 'running',
        })

        const record = workingRegistry.get(item.sourceRelativePath)

        if (!record) {
          completed += 1
          finishLog(logId, { action: 'skip', status: 'done', message: 'Already deleted or not found.' })
          continue
        }

        await removeOriginal(record.handle, record.parentHandle)
        completed += 1
        finishLog(logId, { status: 'done', message: 'Deleted cache/preview item.' })
        setProgress(`Deleted cache/preview: ${item.sourceRelativePath}`)
      }

      if (deleteOperations.length > 0) {
        const postDeleteScan = await scanDirectory(projectRootHandle)
        workingRegistry = postDeleteScan.registry
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

        if (item.sourceRelativePath === item.destinationRelativePath) {
          completed += 1
          finishLog(logId, { action: 'skip', status: 'done', message: 'Already in the requested location.' })
          setProgress(`Skipped: ${item.sourceRelativePath}`)
          continue
        }

        if (item.destinationRelativePath.startsWith(`${item.sourceRelativePath}/`)) {
          throw new Error(`Refusing to move ${item.sourceRelativePath} into itself.`)
        }

        const record = workingRegistry.get(item.sourceRelativePath)

        if (!record) {
          throw new Error(`Missing source handle for ${item.sourceRelativePath}`)
        }

        const { parentParts, destinationName } = destinationParts(item.destinationRelativePath)

        if (!destinationName) {
          completed += 1
          finishLog(logId, { action: 'skip', status: 'done', message: 'No destination path was provided.' })
          setProgress(`Skipped: ${item.sourceRelativePath}`)
          continue
        }

        const destinationDirectory = await getOrCreateDirectoryPath(projectRootHandle, parentParts)
        const existingFolderName =
          record.kind === 'folder' ? await findExistingDirectoryNameCaseInsensitive(destinationDirectory, destinationName) : null
        const shouldMergeFolder =
          record.kind === 'folder' &&
          (isCanonicalMergeOperation(item) || Boolean(existingFolderName && existingFolderName.toLowerCase() === destinationName.toLowerCase()))
        const shouldRenameCaseOnly =
          shouldMergeFolder &&
          existingFolderName &&
          parentParts.length === 0 &&
          existingFolderName === basenameOf(item.sourceRelativePath) &&
          existingFolderName !== destinationName

        const result =
          record.kind === 'file'
            ? await moveFileCopyDelete(record.handle as FileSystemFileHandle, record.parentHandle, destinationDirectory, destinationName, {
                sourceRelativePath: item.sourceRelativePath,
                destinationRelativePath: parentParts.join('/'),
                progressGranularity: 'adaptive',
                onProgress: makeProgressHandler(logId, 'move'),
              })
            : shouldMergeFolder
              ? shouldRenameCaseOnly
                ? await renameDirectoryCopyDelete(record.handle as FileSystemDirectoryHandle, record.parentHandle, destinationName, {
                    sourceRelativePath: item.sourceRelativePath,
                    destinationRelativePath: item.destinationRelativePath,
                    progressGranularity: 'adaptive',
                    onProgress: makeProgressHandler(logId, 'move'),
                  })
                : await mergeDirectoryContentsCopyDelete(
                    record.handle as FileSystemDirectoryHandle,
                    record.parentHandle,
                    await getOrCreateDirectoryPath(projectRootHandle, [...parentParts, existingFolderName ?? destinationName]),
                    {
                      sourceRelativePath: item.sourceRelativePath,
                      destinationRelativePath: item.destinationRelativePath,
                      progressGranularity: 'adaptive',
                      onProgress: makeProgressHandler(logId, 'move'),
                    },
                  )
              : await moveDirectoryCopyDelete(record.handle as FileSystemDirectoryHandle, record.parentHandle, destinationDirectory, destinationName, {
                  sourceRelativePath: item.sourceRelativePath,
                  destinationRelativePath: item.destinationRelativePath,
                  progressGranularity: 'adaptive',
                  onProgress: makeProgressHandler(logId, 'move'),
                })

        completed += 1
        finishLog(logId, {
          status: 'done',
          destination: [...parentParts, result.destinationName].join('/'),
          message: `${formatBytes(result.sizeBytes)} across ${result.files} file${result.files === 1 ? '' : 's'}`,
        })
        flushFileFeed(true)
        setProgress(`Finished: ${item.sourceRelativePath}`)
      }

      const postPlanScan = await scanDirectory(projectRootHandle)
      workingRegistry = postPlanScan.registry
      const resolvedDeliverables = deliverablesAfterPlanOperations(selectedDeliverables, planOperations)

      for (const deliverable of resolvedDeliverables) {
        const logId = `deliverable:${deliverable.sourceRelativePath}`
        setProgress(`Deliverable: ${deliverable.sourceRelativePath}`)
        addLog({
          id: logId,
          source: deliverable.sourceRelativePath,
          destination: deliverable.destinationRelativePath,
          action: copyDeliverables ? 'copy' : 'move',
          status: 'running',
        })

        const originalDeliverable = selectedDeliverables.find((item) => item.id === deliverable.id)
        const fallbackPath = originalDeliverable?.sourceRelativePath
        const record = workingRegistry.get(deliverable.sourceRelativePath) ?? (fallbackPath ? workingRegistry.get(fallbackPath) : undefined)
        const sourceRelativePath = workingRegistry.has(deliverable.sourceRelativePath) ? deliverable.sourceRelativePath : fallbackPath ?? deliverable.sourceRelativePath

        if (!record || record.kind !== 'file') {
          throw new Error(`Missing source file handle for selected deliverable ${deliverable.sourceRelativePath}`)
        }

        const deliverablesDirectory = await getOrCreateDirectoryPath(projectRootHandle, ['Deliverables'])
        const destinationName = basenameOf(deliverable.destinationRelativePath)
        const result = copyDeliverables
          ? await copyFile(record.handle as FileSystemFileHandle, deliverablesDirectory, destinationName, {
              sourceRelativePath,
              destinationRelativePath: 'Deliverables',
              progressGranularity: 'adaptive',
              onProgress: makeProgressHandler(logId, 'copy'),
            })
          : await moveFileCopyDelete(record.handle as FileSystemFileHandle, record.parentHandle, deliverablesDirectory, destinationName, {
              sourceRelativePath,
              destinationRelativePath: 'Deliverables',
              progressGranularity: 'adaptive',
              onProgress: makeProgressHandler(logId, 'move'),
            })

        completed += 1
        finishLog(logId, {
          status: 'done',
          destination: `Deliverables/${result.destinationName}`,
          message: `${formatBytes(result.sizeBytes)} ${copyDeliverables ? 'copied' : 'moved'}`,
        })
        flushFileFeed(true)
        setProgress(`Finished deliverable: ${deliverable.sourceRelativePath}`)
      }

      setProgress('Removing empty folders')
      await removeEmptyDirectories(projectRootHandle, '', (relativePath) => {
        const cleanupLog = {
          id: `cleanup:${relativePath}`,
          source: relativePath,
          destination: '',
          action: 'cleanup',
          status: 'done',
          message: 'Removed empty folder.',
        } satisfies ApplyLogItem
        cleanupLogs.push(cleanupLog)
        addLog(cleanupLog)
      })
      setCleanupActions(cleanupLogs)
      completed += 1

      setProgress('Writing reports')
      flushFileFeed(true)
      const afterScan = await scanDirectory(projectRootHandle)
      const validation = validateOrganizedProject(afterScan.manifest, selectedDeliverables, { hiddenFilesVisible: showHiddenSystemFiles })
      setValidationResult(validation)
      const tree = await readDirectoryTree(projectRootHandle, 4)
      const report = buildReport(destinationLabel, logs, tree, validation, cleanupLogs)
      await writeTextFile(projectRootHandle, 'ORGANIZATION_REPORT.json', generateReportJson(report))
      await writeTextFile(projectRootHandle, 'ORGANIZATION_REPORT.md', generateReportMarkdown(report))
      completed += 3
      addLog({
        id: 'report',
        source: 'Project Porter',
        destination: 'ORGANIZATION_REPORT.md / ORGANIZATION_REPORT.json',
        action: 'report',
        status: 'done',
      })
      setApplyProgress({
        current: 'Complete',
        completed,
        total: totalActions,
        completedFiles: workSummary.totalFiles,
        totalFiles: workSummary.totalFiles,
        copiedBytes: workSummary.totalBytes,
        totalBytes: workSummary.totalBytes,
      })
      setApplyFileRecords([...fileProgressById.values()])
      setApplyTiming({
        startedAt: applyStartedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - applyStartedAtMs),
      })
      setFinalTree(tree)
      setReportPath(`${destinationLabel}/ORGANIZATION_REPORT.md`)
      setStep('done')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Organization failed.'
      setApplyError(message)
      addLog({
        id: `error:${Date.now()}`,
        source: currentApplyText || 'Apply',
        destination: '',
        action: 'error',
        status: 'error',
        message,
      })
      setApplyTiming({
        startedAt: applyStartedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Math.round(performance.now() - applyStartedAtMs),
      })

      if (projectRootHandle) {
        try {
          const tree = await readDirectoryTree(projectRootHandle, 4)
          const report = buildReport(destinationLabel, logs, tree, validationResult, cleanupLogs)
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

  async function cleanUpExistingProject() {
    if (!sourceHandle || mockMode) {
      return
    }

    const confirmed = window.confirm('Clean up this existing organized project? Project Porter will modify the selected folder using copy, verify, then delete operations.')

    if (!confirmed) {
      return
    }

    setCleanupStatus('Scanning existing organized project...')
    setStep('apply')
    setApplying(true)
    setApplyError('')
    setApplyLogs([])
    setApplyFeed([])
    setApplyFileRecords([])
    setApplyProgress(emptyApplyProgress)
    setCleanupActions([])
    setValidationResult(null)
    setOrganizedProjectHandle(sourceHandle)

    const logs: ApplyLogItem[] = []
    const cleanupLogs: ApplyLogItem[] = []
    let completed = 0
    let cleanupTotalActions = 4

    function setProgress(current: string) {
      setApplyProgress({
        current,
        completed,
        total: cleanupTotalActions,
        completedFiles: completed,
        totalFiles: 4,
        copiedBytes: completed,
        totalBytes: 4,
      })
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

    try {
      const scan = await scanDirectory(sourceHandle)
      const cleanupPlan = applyCacheDeletionPreference(createReviewItems(buildCleanupPlan(scan.manifest), scan.manifest), deleteCacheFiles)
      const deleteOperations = cleanupPlan.filter((item) => item.enabled && item.operation === 'delete')
      const normalized = normalizePlanForApply(cleanupPlan.filter((item) => item.operation !== 'delete'))
      cleanupTotalActions = deleteOperations.length + normalized.operations.length + 3
      let workingRegistry = scan.registry

      for (const item of deleteOperations) {
        const logId = `cleanup-delete:${item.sourceRelativePath}`
        setProgress(`Deleting cache/preview: ${item.sourceRelativePath}`)
        addLog({
          id: logId,
          source: item.sourceRelativePath,
          destination: '',
          action: 'delete',
          status: 'running',
        })

        const record = workingRegistry.get(item.sourceRelativePath)

        if (!record) {
          completed += 1
          finishLog(logId, { action: 'skip', status: 'done', message: 'Already deleted or not found.' })
          continue
        }

        await removeOriginal(record.handle, record.parentHandle)
        completed += 1
        finishLog(logId, { status: 'done', message: 'Deleted cache/preview item.' })
      }

      if (deleteOperations.length > 0) {
        const nextScan = await scanDirectory(sourceHandle)
        workingRegistry = nextScan.registry
      }

      for (const item of normalized.operations) {
        const logId = `cleanup-plan:${item.sourceRelativePath}`
        setProgress(`Cleaning up: ${item.sourceRelativePath}`)
        addLog({
          id: logId,
          source: item.sourceRelativePath,
          destination: item.destinationRelativePath,
          action: 'move',
          status: 'running',
        })

        if (item.sourceRelativePath === item.destinationRelativePath) {
          completed += 1
          finishLog(logId, { action: 'skip', status: 'done', message: 'Already in the requested location.' })
          continue
        }

        const record = workingRegistry.get(item.sourceRelativePath)

        if (!record) {
          finishLog(logId, { status: 'error', message: 'Missing source handle.' })
          continue
        }

        const { parentParts, destinationName } = destinationParts(item.destinationRelativePath)

        if (!destinationName) {
          finishLog(logId, { action: 'skip', status: 'done', message: 'No destination path was provided.' })
          continue
        }

        const destinationDirectory = await getOrCreateDirectoryPath(sourceHandle, parentParts)
        const existingFolderName =
          record.kind === 'folder' ? await findExistingDirectoryNameCaseInsensitive(destinationDirectory, destinationName) : null
        const shouldMergeFolder =
          record.kind === 'folder' &&
          (isCanonicalMergeOperation(item) || Boolean(existingFolderName && existingFolderName.toLowerCase() === destinationName.toLowerCase()))

        const result =
          record.kind === 'file'
            ? await moveFileCopyDelete(record.handle as FileSystemFileHandle, record.parentHandle, destinationDirectory, destinationName, {
                sourceRelativePath: item.sourceRelativePath,
                destinationRelativePath: parentParts.join('/'),
                progressGranularity: 'completion',
              })
            : shouldMergeFolder
              ? await mergeDirectoryContentsCopyDelete(
                  record.handle as FileSystemDirectoryHandle,
                  record.parentHandle,
                  await getOrCreateDirectoryPath(sourceHandle, [...parentParts, existingFolderName ?? destinationName]),
                  {
                    sourceRelativePath: item.sourceRelativePath,
                    destinationRelativePath: item.destinationRelativePath,
                    progressGranularity: 'completion',
                  },
                )
              : await moveDirectoryCopyDelete(record.handle as FileSystemDirectoryHandle, record.parentHandle, destinationDirectory, destinationName, {
                  sourceRelativePath: item.sourceRelativePath,
                  destinationRelativePath: item.destinationRelativePath,
                  progressGranularity: 'completion',
                })

        completed += 1
        finishLog(logId, {
          status: 'done',
          destination: [...parentParts, result.destinationName].join('/'),
          message: `${formatBytes(result.sizeBytes)} across ${result.files} file${result.files === 1 ? '' : 's'}`,
        })

        if (record.kind === 'folder') {
          const nextScan = await scanDirectory(sourceHandle)
          workingRegistry = nextScan.registry
        }
      }

      setProgress('Removing empty folders')
      await removeEmptyDirectories(sourceHandle, '', (relativePath) => {
        const cleanupLog = {
          id: `cleanup-empty:${relativePath}`,
          source: relativePath,
          destination: '',
          action: 'cleanup',
          status: 'done',
          message: 'Removed empty folder.',
        } satisfies ApplyLogItem
        cleanupLogs.push(cleanupLog)
        addLog(cleanupLog)
      })
      setCleanupActions(cleanupLogs)
      completed += 1

      setProgress('Validating cleanup')
      const afterScan = await scanDirectory(sourceHandle)
      const validation = validateOrganizedProject(afterScan.manifest, [], { hiddenFilesVisible: showHiddenSystemFiles })
      setValidationResult(validation)
      const tree = await readDirectoryTree(sourceHandle, 4)
      setFinalTree(tree)
      completed += 1

      setProgress('Writing cleanup report')
      const cleanupReport: CleanupReport = {
        appName: 'Project Porter',
        createdAt: new Date().toISOString(),
        sourceFolder: sourceHandle.name,
        mode: 'cleanup-existing-organized-project',
        organizationMode: 'rules-only',
        aiUsed: false,
        movedItems: logs,
        cleanupActions: cleanupLogs,
        validation,
        warnings: normalized.warnings,
        errors: logs.filter((item) => item.status === 'error').map((item) => item.message ?? item.source),
        finalTree: tree,
      }
      await writeTextFile(sourceHandle, 'CLEANUP_REPORT.json', generateCleanupReportJson(cleanupReport))
      await writeTextFile(sourceHandle, 'CLEANUP_REPORT.md', generateCleanupReportMarkdown(cleanupReport))
      completed += 1
      setReportPath(`${sourceHandle.name}/CLEANUP_REPORT.md`)
      setCleanupStatus('Cleanup complete.')
      setApplyProgress({
        current: 'Cleanup complete',
        completed,
        total: cleanupTotalActions,
        completedFiles: cleanupTotalActions,
        totalFiles: cleanupTotalActions,
        copiedBytes: cleanupTotalActions,
        totalBytes: cleanupTotalActions,
      })
      setStep('done')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Cleanup failed.'
      setApplyError(message)
      setCleanupStatus(message)
      addLog({
        id: `cleanup-error:${Date.now()}`,
        source: 'Cleanup',
        destination: '',
        action: 'error',
        status: 'error',
        message,
      })
    } finally {
      setApplying(false)
    }
  }

  function buildReport(
    destinationLabel: string,
    logs: ApplyLogItem[],
    tree: string[],
    validation: ValidationResult | null = validationResult,
    cleanupLogs: ApplyLogItem[] = cleanupActions,
  ): OrganizationReport {
    return {
      appName: 'Project Porter',
      createdAt: new Date().toISOString(),
      projectName: projectName.trim(),
      sourceFolder: sourceRootName,
      destinationFolder: destinationLabel,
      mode: importMode ? 'import-to-destination' : 'organize-in-place',
      organizationMode,
      aiUsed: organizationMode !== 'rules-only' && !aiStatus.aiFallbackUsed && Boolean(aiStatus.aiRequestCompleted),
      aiCandidateCount: aiStatus.aiItemsSentCount,
      aiFallbackReason: aiStatus.aiFallbackReason,
      copyDeliverables,
      deleteCacheFiles,
      totals,
      appliedPlan: enabledPlanItems,
      skippedPlan: reviewItems.filter((item) => !item.enabled || item.category === '_Needs Review' || item.category === 'Ignore'),
      deliverables,
      logs,
      cleanupActions: cleanupLogs,
      validation,
      warnings: [...warnings, ...normalizePlanForApply(enabledPlanItems.filter((item) => item.operation !== 'delete')).warnings],
      errors: applyError ? [applyError] : [],
      finalTree: tree,
    }
  }

  async function downloadCompactDebugLog() {
    const startedAt = new Date().toISOString()
    setDebugLogStatus('Preparing compact debug log...')

    try {
      const backendHealth = await readBackendHealth()
      let afterScan: CompactDebugLog['afterScan'] = null
      const logNotes: string[] = []

      if (organizedProjectHandle) {
        try {
          setDebugLogStatus('Scanning compact after state...')
          const scanResult = await scanDirectory(organizedProjectHandle)
          afterScan = {
            rootName: organizedProjectHandle.name,
            totals: scanResult.totals,
            tree: compactManifestTree(scanResult.manifest, organizedProjectHandle.name, 4, 50),
          }
        } catch (error) {
          logNotes.push(`After-state scan failed but log export continued: ${errorMessage(error)}`)
        }
      }

      const compactLog: CompactDebugLog = {
        appName: 'Project Porter',
        createdAt: new Date().toISOString(),
        purpose: 'Compact troubleshooting log for Project Porter organization runs.',
        debugDepth: 'compact',
        environment: {
          userAgent: navigator.userAgent,
          language: navigator.language,
          platform: navigator.platform,
          location: window.location.href,
          fileSystemAccessSupported: typeof window.showDirectoryPicker === 'function',
          backendHealth,
        },
        settings: {
          projectName: projectName.trim(),
          projectDate,
          finalFolderName,
          sourceRootName,
          destinationRootName: destinationHandle?.name ?? null,
          mode: importMode ? 'import-to-destination' : 'organize-in-place',
          copyDeliverables,
          deleteCacheFiles,
          mockMode,
          reportPath,
          organizationMode,
          showHiddenSystemFiles,
          aiSettings,
        },
        aiStatus,
        aiReviewPacket: null,
        aiResponseSummary,
        validationResults: validationResult,
        cleanupActions,
        runtimeEvents,
        workflowState: {
          currentStep: step,
          reviewed,
          planSource,
          planSummary,
          detectedApps,
          warnings,
          needsReviewCount,
          totalPlannedSizeBytes: totalPlannedSize,
          applyError,
        },
        beforeScan: {
          rootName: sourceRootName,
          totals,
          tree: compactManifestTree(planningManifest, sourceRootName, 4, 50),
        },
        classification: {
          reviewItems: reviewItems.slice(0, 250),
          enabledPlanItems: enabledPlanItems.slice(0, 250),
          skippedPlanItems: reviewItems.filter((item) => !item.enabled || item.category === '_Needs Review' || item.category === 'Ignore').slice(0, 250),
          deliverables,
          selectedDeliverables,
        },
        apply: {
          timing: applyTiming,
          progress: applyProgress,
          feed: applyFeed.slice(0, 50),
          fileRecords: applyFileRecords.slice(0, 50),
          logs: applyLogs,
        },
        afterScan,
        aiReviewPacketSummary: aiReviewPacket ? summarizeAiPacket(aiReviewPacket) : null,
        commandOutputs: [
          {
            label: 'Browser runtime',
            command: null,
            output: 'Compact browser log. No terminal output is captured here.',
            exitCode: null,
            capturedAt: startedAt,
          },
        ],
        notes: [
          'This compact log excludes file contents, environment variables, API keys, hidden/system files, and the full deep manifest.',
          'AI request details are summarized; use full deep debug only when troubleshooting candidate construction.',
          ...logNotes,
        ],
      }

      const safeName = safeFolderSegment(projectName || sourceRootName || 'Project Porter').replace(/\s+/g, '_') || 'Project_Porter'
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const fileName = `${safeName}_Project_Porter_compact_debug_log_${stamp}.json`

      downloadTextFile(fileName, generateCompactDebugLogJson(compactLog), 'application/json')
      setDebugLogStatus(`Downloaded ${fileName}`)
    } catch (error) {
      const message = errorMessage(error)
      const safeName = safeFolderSegment(projectName || sourceRootName || 'Project Porter').replace(/\s+/g, '_') || 'Project_Porter'
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const fileName = `${safeName}_Project_Porter_emergency_debug_log_${stamp}.json`
      const emergencyLog = {
        appName: 'Project Porter',
        createdAt: new Date().toISOString(),
        purpose: 'Emergency troubleshooting log created after compact debug export failed.',
        exportError: message,
        runtimeEvents,
        state: {
          step,
          projectName,
          sourceRootName,
          organizationMode,
          planSource,
          planSummary,
          warnings,
          applyError,
          aiStatus,
          manifestCount: manifest.length,
          reviewItemCount: reviewItems.length,
          deliverableCount: deliverables.length,
          applyLogCount: applyLogs.length,
        },
      }

      downloadTextFile(fileName, JSON.stringify(emergencyLog, null, 2), 'application/json')
      setDebugLogStatus(`Compact log failed, downloaded emergency log: ${fileName}`)
    }
  }

  async function downloadDebugLog() {
    const startedAt = new Date().toISOString()
    setDebugLogStatus('Preparing debug log...')

    try {
      const backendHealth = await readBackendHealth()
      let afterScan: DebugLog['afterScan'] = null
      const logNotes: string[] = []

      if (organizedProjectHandle) {
        try {
          setDebugLogStatus('Scanning organized project for debug log...')
          let lastDebugScanUpdate = 0
          const scanResult = await scanDirectory(organizedProjectHandle, (progress) => {
            const now = performance.now()

            if (now - lastDebugScanUpdate >= 400) {
              lastDebugScanUpdate = now
              setDebugLogStatus(`Scanning after state: ${progress.files.toLocaleString()} files, ${progress.folders.toLocaleString()} folders`)
            }
          })
          setDebugLogStatus('Building final tree for debug log...')
          const tree = await readDirectoryTree(organizedProjectHandle, 8)
          afterScan = {
            rootName: organizedProjectHandle.name,
            totals: scanResult.totals,
            manifest: scanResult.manifest,
            tree,
          }
        } catch (error) {
          logNotes.push(`After-state scan/tree failed but log export continued: ${errorMessage(error)}`)
        }
      }

      const debugLog: DebugLog = {
        appName: 'Project Porter',
        createdAt: new Date().toISOString(),
        purpose: 'User-downloadable troubleshooting log for Project Porter organization runs.',
        environment: {
          userAgent: navigator.userAgent,
          language: navigator.language,
          platform: navigator.platform,
          location: window.location.href,
          fileSystemAccessSupported: typeof window.showDirectoryPicker === 'function',
          backendHealth,
        },
        settings: {
          projectName: projectName.trim(),
          projectDate,
          finalFolderName,
          sourceRootName,
          destinationRootName: destinationHandle?.name ?? null,
          mode: importMode ? 'import-to-destination' : 'organize-in-place',
          copyDeliverables,
          deleteCacheFiles,
          mockMode,
          reportPath,
          organizationMode,
          showHiddenSystemFiles,
          aiSettings,
        },
        aiStatus,
        aiReviewPacket,
        aiResponseSummary,
        validationResults: validationResult,
        cleanupActions,
        runtimeEvents,
        workflowState: {
          currentStep: step,
          reviewed,
          planSource,
          planSummary,
          detectedApps,
          warnings,
          needsReviewCount,
          totalPlannedSizeBytes: totalPlannedSize,
          applyError,
        },
        beforeScan: {
          rootName: sourceRootName,
          totals,
          manifest,
        },
        classification: {
          reviewItems,
          enabledPlanItems,
          skippedPlanItems: reviewItems.filter((item) => !item.enabled || item.category === '_Needs Review' || item.category === 'Ignore'),
          deliverables,
          selectedDeliverables,
        },
        apply: {
          timing: applyTiming,
          progress: applyProgress,
          feed: applyFeed,
          fileRecords: applyFileRecords,
          logs: applyLogs,
        },
        afterScan,
        commandOutputs: [
          {
            label: 'Browser runtime',
            command: null,
            output: 'Project Porter does not execute terminal commands from the browser, so no shell command output is captured here.',
            exitCode: null,
            capturedAt: startedAt,
            note: 'Attach separate terminal output for npm run build, npm run lint, or server logs when needed.',
          },
        ],
        notes: [
          'This log intentionally excludes file contents, environment variables, and API keys.',
          'Manifest entries include names, relative paths, extensions, sizes, modified dates, child counts, and sample children only.',
          afterScan ? 'After scan was captured from the organized project folder.' : 'After scan was unavailable because the organized project folder handle is not available in this browser session.',
          ...logNotes,
        ],
      }

      const safeName = safeFolderSegment(projectName || sourceRootName || 'Project Porter').replace(/\s+/g, '_') || 'Project_Porter'
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const fileName = `${safeName}_Project_Porter_debug_log_${stamp}.json`

      downloadTextFile(fileName, generateDebugLogJson(debugLog), 'application/json')
      setDebugLogStatus(`Downloaded ${fileName}`)
    } catch (error) {
      setDebugLogStatus(error instanceof Error ? `Could not prepare debug log: ${error.message}` : 'Could not prepare debug log.')
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
          <div className="flex flex-col gap-2 md:items-end">
            <div className="flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
              <ShieldCheck className="size-4" aria-hidden="true" />
              Media stays in your browser. Only names and metadata are sent to the local API.
            </div>
            <div className="flex flex-wrap justify-start gap-2 md:justify-end">
              <button className="btn-secondary min-h-9 px-3 py-2 text-xs" type="button" disabled={debugLogBusy} onClick={downloadCompactDebugLog}>
                {debugLogBusy ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : <Download className="size-3.5" aria-hidden="true" />}
                Export Current Log
              </button>
              <button className="btn-ghost min-h-9 px-3 py-2 text-xs" type="button" disabled={debugLogBusy} onClick={downloadDebugLog}>
                <Download className="size-3.5" aria-hidden="true" />
                Full Log
              </button>
            </div>
            {debugLogStatus && <p className="max-w-md text-right text-xs text-stone-500">{debugLogStatus}</p>}
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
              <button className="btn-secondary mt-3 w-full" type="button" disabled={!sourceHandle || mockMode || applying} onClick={cleanUpExistingProject}>
                <RefreshCw className="size-4" aria-hidden="true" />
                Clean Up Existing Organized Project
              </button>
              {cleanupStatus && <p className="mt-3 text-sm text-stone-500">{cleanupStatus}</p>}
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
                  <p className="font-medium">{importMode ? 'Import into destination: this will copy first, then organize the copy.' : 'Organize in place: this will modify the selected folder.'}</p>
                  <p className="mt-1 text-sky-800">
                    Project Porter scans names, paths, sizes, extensions, and modified dates. It never reads media contents or uploads media files.
                  </p>
                </div>

                <OrganizationModeSelector
                  value={organizationMode}
                  onChange={(nextMode) => {
                    setOrganizationMode(nextMode)
                    setAiStatus((status) => ({ ...status, organizationMode: nextMode, aiEnabled: nextMode !== 'rules-only' }))
                  }}
                />

                <label className="choice items-start">
                  <input
                    type="checkbox"
                    checked={deleteCacheFiles}
                    onChange={(event) => {
                      const nextValue = event.target.checked
                      setDeleteCacheFiles(nextValue)
                      setReviewItems((items) => applyCacheDeletionPreference(items, nextValue))
                    }}
                  />
                  <span>
                    <span className="block">Delete cache and preview files</span>
                    <span className="mt-1 block text-xs font-normal text-stone-500">Default on. Turn this off to preserve Media Cache, Premiere previews, .pek, .cfa, .ims, .mcdb, and .sfk files in Assets.</span>
                  </span>
                </label>

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
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <label className="choice">
                <input type="checkbox" checked={showHiddenSystemFiles} onChange={(event) => setShowHiddenSystemFiles(event.target.checked)} />
                <span>Show hidden/system files</span>
              </label>
              {aiCandidatePreview && organizationMode !== 'rules-only' && (
                <Badge tone={aiCandidatePreview.aiEstimatedTokenRisk === 'high' ? 'warning' : 'neutral'}>
                  AI Review: {aiCandidatePreview.itemCount} item{aiCandidatePreview.itemCount === 1 ? '' : 's'} will be sent
                </Badge>
              )}
            </div>
            <ManifestPreview manifest={visibleManifest} />
            <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950">
              AI only reviews uncertain items. Most files are organized locally by rules. No media files are uploaded.
              {aiCandidatePreview?.compacted ? ' Large project detected. AI will review summaries only.' : ''}
            </div>
            <div className="mt-5 flex flex-wrap gap-3">
              {!mockMode && (
                <button className="btn-secondary" type="button" disabled={scanning || !sourceHandle} onClick={startScan}>
                  <RefreshCw className="size-4" aria-hidden="true" />
                  Rescan
                </button>
              )}
              <button className="btn-primary" type="button" disabled={!scanReady || scanning} onClick={createAiPlan}>
                {organizationMode === 'rules-only' ? <ClipboardCheck className="size-4" aria-hidden="true" /> : <Sparkles className="size-4" aria-hidden="true" />}
                {organizationMode === 'rules-only' ? 'Create Smart Rules Plan' : 'Create Smart Rules + AI Review Plan'}
              </button>
            </div>
          </Workspace>
        )}

        {step === 'ai' && (
          <Workspace>
            <SectionTitle icon={Sparkles} title="Plan" detail={organizationMode === 'rules-only' ? 'Smart Rules are building the local plan.' : 'Smart Rules are sending only uncertain items for AI review.'} />
            <ProgressPanel
              title="Building organization plan"
              current={organizationMode === 'rules-only' ? 'Classifying locally with deterministic rules' : `AI Review: ${aiStatus.aiItemsSentCount || aiCandidatePreview?.itemCount || 0} compact items`}
              value={65}
              active={planning}
            />
            <div className="mt-5 rounded-lg border border-stone-200 bg-stone-50 p-4 text-sm text-stone-600">
              {organizationMode === 'rules-only'
                ? 'Smart Rules Only mode is free, private, and makes no OpenAI call.'
                : 'AI receives a compact review packet, not the full file tree. If AI fails, Project Porter shows the reason and continues with Smart Rules.'}
            </div>
          </Workspace>
        )}

        {step === 'review' && (
          <Workspace wide>
            <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <SectionTitle icon={ClipboardCheck} title="Review Plan" detail={planSource || planSummary || 'Review every proposed operation before applying.'} />
              <div className="flex flex-wrap gap-2">
                <Badge tone="neutral">{planSource || 'Plan ready'}</Badge>
                {aiStatus.aiEnabled && <Badge tone={aiStatus.aiFallbackUsed ? 'warning' : 'neutral'}>{aiStatus.aiItemsSentCount} AI review items</Badge>}
                {needsReviewCount > 0 && <Badge tone="warning">{needsReviewCount} warnings / review flags</Badge>}
              </div>
            </div>

            {aiStatus.aiFallbackReason && <WarningBox>AI review was skipped or failed: {aiStatus.aiFallbackReason}</WarningBox>}
            {organizationMode === 'force-ai-debug' && aiReviewPacket && (
              <SummaryCard title="Force AI Debug">
                <SummaryRow label="Items sent" value={String(aiStatus.aiItemsSentCount)} />
                <SummaryRow label="Token risk" value={aiStatus.aiEstimatedTokenRisk} />
                <SummaryRow label="Model" value={aiStatus.model || 'Unknown'} />
                <SummaryRow label="Duration" value={aiStatus.aiDurationMs === null ? '-' : `${aiStatus.aiDurationMs} ms`} />
              </SummaryCard>
            )}

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
                <SummaryRow label="Cache handling" value={deleteCacheFiles ? 'Delete cache/previews' : 'Preserve in Assets'} />
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
                <SummaryRow label="Cache handling" value={deleteCacheFiles ? 'Delete cache/previews' : 'Preserve in Assets'} />
                <SummaryRow label="Total size" value={formatBytes(totalPlannedSize)} />
                <SummaryRow label="Deliverables selected" value={String(selectedDeliverables.length)} />
                <SummaryRow label="Needs review count" value={String(needsReviewCount)} />
              </SummaryCard>
              <TreePreview title="Folder Preview" lines={previewTree} highlightNeedsReview />
            </div>

            {mockMode && <WarningBox>Mock mode is preview-only. Select real source and destination folders to apply file operations.</WarningBox>}
            {!mockMode && !importMode && <WarningBox>Organize in place will modify the selected source folder. Project Porter copies and verifies before deleting originals.</WarningBox>}
            {!mockMode && importMode && <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-950">Import mode copies the source into the destination project folder first. The original source folder is not modified.</div>}
            {applyError && <WarningBox>{applyError}</WarningBox>}

            <div className="mt-5 rounded-lg border border-stone-200 bg-stone-50 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-medium">{applying ? 'Applying organization' : 'Ready to apply'}</p>
                  <p className="text-sm text-stone-500">{applyProgress.current || 'No file operation has started.'}</p>
                </div>
                <span className="text-sm text-stone-500">
                  {applyProgress.completed}/{applyProgress.total} actions
                </span>
              </div>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div>
                  <div className="flex justify-between gap-3 text-xs font-medium text-stone-500">
                    <span>Files</span>
                    <span>
                      {applyProgress.completedFiles}/{applyProgress.totalFiles}
                      {applyProgress.totalFiles ? ` (${Math.round((applyProgress.completedFiles / applyProgress.totalFiles) * 100)}%)` : ''}
                    </span>
                  </div>
                  <ProgressBar value={applyProgress.totalFiles ? (applyProgress.completedFiles / applyProgress.totalFiles) * 100 : 0} active={applying} />
                </div>
                <div>
                  <div className="flex justify-between gap-3 text-xs font-medium text-stone-500">
                    <span>Bytes</span>
                    <span>
                      {formatBytes(applyProgress.copiedBytes)} / {formatBytes(applyProgress.totalBytes)}
                      {applyProgress.totalBytes ? ` (${Math.round((applyProgress.copiedBytes / applyProgress.totalBytes) * 100)}%)` : ''}
                    </span>
                  </div>
                  <ProgressBar value={applyProgress.totalBytes ? (applyProgress.copiedBytes / applyProgress.totalBytes) * 100 : 0} active={applying} />
                </div>
              </div>
              <div className="mt-4">
                <div className="flex justify-between gap-3 text-xs font-medium text-stone-500">
                  <span>Actions</span>
                  <span>
                    {applyProgress.completed}/{applyProgress.total}
                    {applyProgress.total ? ` (${Math.round((applyProgress.completed / applyProgress.total) * 100)}%)` : ''}
                  </span>
                </div>
                <ProgressBar value={applyProgress.total ? (applyProgress.completed / applyProgress.total) * 100 : 0} active={applying} />
              </div>
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
                <SummaryRow label="Validation" value={validationResult?.message ?? 'Not run'} />
              </SummaryCard>
              <TreePreview title="Final Project Tree" lines={finalTree.length ? finalTree : previewTree} highlightNeedsReview />
            </div>

            {validationResult && (
              <div
                className={[
                  'mt-5 rounded-lg border p-4 text-sm',
                  validationResult.severity === 'green'
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-950'
                    : validationResult.severity === 'yellow'
                      ? 'border-amber-200 bg-amber-50 text-amber-950'
                      : 'border-red-200 bg-red-50 text-red-950',
                ].join(' ')}
              >
                <p className="font-medium">{validationResult.message}</p>
                {validationResult.issues.length > 0 && (
                  <ul className="mt-2 list-disc space-y-1 pl-5">
                    {validationResult.issues.slice(0, 8).map((issue) => (
                      <li key={`${issue.code}:${issue.path}`}>
                        {issue.path}: {issue.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

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
              <button className="btn-secondary" type="button" disabled={debugLogBusy} onClick={downloadCompactDebugLog}>
                {debugLogBusy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Download className="size-4" aria-hidden="true" />}
                Export Compact Debug Log
              </button>
              <button className="btn-secondary" type="button" disabled={debugLogBusy} onClick={downloadDebugLog}>
                {debugLogBusy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Download className="size-4" aria-hidden="true" />}
                Export Full Deep Debug Log
              </button>
            </div>
            {debugLogStatus && <p className="mt-3 text-sm text-stone-500">{debugLogStatus}</p>}
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

function OrganizationModeSelector({ value, onChange }: { value: OrganizationMode; onChange: (value: OrganizationMode) => void }) {
  const options: Array<{ value: OrganizationMode; label: string; detail: string }> = [
    { value: 'rules-only', label: 'Smart Rules Only', detail: 'Default, free, private, and no OpenAI call.' },
    { value: 'rules-plus-ai-review', label: 'Smart Rules + Lightweight AI Review', detail: 'Only uncertain items are sent for override suggestions.' },
    { value: 'force-ai-debug', label: 'Force AI Debug Mode', detail: 'Developer mode with compact request/response metadata.' },
  ]

  return (
    <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
      <div className="mb-3 flex items-center gap-2">
        <Sparkles className="size-4 text-stone-600" aria-hidden="true" />
        <p className="font-medium">Organization Mode</p>
      </div>
      <div className="grid gap-2">
        {options.map((option) => (
          <label key={option.value} className="choice items-start">
            <input type="radio" name="organization-mode" checked={value === option.value} onChange={() => onChange(option.value)} />
            <span>
              <span className="block">{option.label}</span>
              <span className="mt-1 block text-xs font-normal text-stone-500">{option.detail}</span>
            </span>
          </label>
        ))}
      </div>
      <p className="mt-3 text-xs text-stone-500">AI only reviews uncertain items. Most files are organized locally by rules.</p>
    </div>
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
              <tr key={item.id} className={`border-t border-stone-100 ${item.operation === 'delete' ? 'bg-red-50/50' : item.category === '_Needs Review' ? 'bg-amber-50/60' : 'bg-white'}`}>
                <td className="px-3 py-3 align-top">
                  <input className="size-4 accent-stone-950" type="checkbox" checked={item.enabled} onChange={(event) => onChange(item.id, { enabled: event.target.checked })} />
                </td>
                <td className="max-w-[220px] px-3 py-3 align-top font-medium">
                  <span className="block truncate" title={item.sourceRelativePath}>
                    {item.sourceRelativePath}
                  </span>
                </td>
                <td className="px-3 py-3 align-top">
                  {item.operation === 'delete' ? (
                    <div className="input flex h-9 min-w-[260px] items-center bg-red-50 text-red-800">Delete cache/preview</div>
                  ) : (
                    <input
                      className="input h-9 min-w-[260px]"
                      value={item.destinationRelativePath}
                      onChange={(event) => onChange(item.id, { destinationRelativePath: event.target.value })}
                      disabled={item.category === 'Ignore'}
                    />
                  )}
                </td>
                <td className="px-3 py-3 align-top">
                  <select
                    className="input h-9 min-w-[150px]"
                    value={item.category}
                    onChange={(event) => onChange(item.id, categoryPatch(event.target.value as MoveCategory, item))}
                    disabled={item.operation === 'delete'}
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
    return { category, enabled: false, destinationRelativePath: '', requiresReview: false, operation: 'move' }
  }

  if (category === '_Needs Review') {
    return { category, enabled: true, destinationRelativePath: `_Needs Review/${basenameOf(item.sourceRelativePath)}`, requiresReview: true, operation: 'move' }
  }

  return {
    category,
    enabled: true,
    requiresReview: false,
    operation: 'move',
    destinationRelativePath: `${category}/${basenameOf(item.sourceRelativePath)}`,
  }
}

const cacheFolderNamePattern = /(^|\/)(Adobe Premiere Pro Video Previews|Adobe Premiere Pro Audio Previews|Media Cache|Cache|Peak Files|Preview Files)(\/|$)/i
const cacheFileExtensionPattern = /\.(pek|cfa|ims|mcdb|sfk)$/i

function applyCacheDeletionPreference(items: ReviewPlanItem[], deleteCacheFiles: boolean) {
  return items.map((item) => {
    if (!isCacheReviewItem(item)) {
      return item.operation === 'delete'
        ? {
            ...item,
            operation: 'move' as const,
            destinationRelativePath: item.preserveDestinationRelativePath ?? item.destinationRelativePath,
            warning: item.warning?.replace(/Will delete cache\/preview files by default\.?/i, '').trim() || undefined,
          }
        : item
    }

    const preserveDestinationRelativePath = item.preserveDestinationRelativePath ?? item.destinationRelativePath

    if (!deleteCacheFiles) {
      return {
        ...item,
        operation: 'move' as const,
        preserveDestinationRelativePath,
        destinationRelativePath: preserveDestinationRelativePath,
        enabled: item.category !== 'Ignore' && Boolean(preserveDestinationRelativePath),
        warning: item.warning?.replace(/Will delete cache\/preview files by default\.?/i, '').trim() || undefined,
      }
    }

    return {
      ...item,
      operation: 'delete' as const,
      preserveDestinationRelativePath,
      enabled: true,
      warning: [item.warning, 'Will delete cache/preview files by default.'].filter(Boolean).join(', '),
    }
  })
}

function isCacheReviewItem(item: ReviewPlanItem) {
  return (
    cacheFolderNamePattern.test(item.sourceRelativePath) ||
    cacheFolderNamePattern.test(item.destinationRelativePath) ||
    cacheFileExtensionPattern.test(item.sourceRelativePath) ||
    cacheFileExtensionPattern.test(item.destinationRelativePath) ||
    /cache|preview|peak/i.test(item.reason)
  )
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

function compactManifestTree(manifest: ManifestItem[], rootName: string, maxDepth: number, maxChildrenPerFolder: number) {
  const visible = manifest.filter((item) => !isHiddenSystemPath(item.relativePath))
  const childrenByParent = new Map<string, ManifestItem[]>()

  for (const item of visible) {
    const parent = item.relativePath.split('/').slice(0, -1).join('/')
    childrenByParent.set(parent, [...(childrenByParent.get(parent) ?? []), item])
  }

  for (const [parent, children] of childrenByParent) {
    childrenByParent.set(
      parent,
      children.sort((left, right) => {
        if (left.kind !== right.kind) {
          return left.kind === 'folder' ? -1 : 1
        }

        return left.name.localeCompare(right.name)
      }),
    )
  }

  function walk(parent: string, depth: number): unknown[] {
    if (depth > maxDepth) {
      return []
    }

    const children = childrenByParent.get(parent) ?? []
    const shown = children.slice(0, maxChildrenPerFolder)
    const rows = shown.map((item) => ({
      name: item.name,
      kind: item.kind,
      relativePath: item.relativePath,
      children: item.kind === 'folder' ? walk(item.relativePath, depth + 1) : undefined,
    }))

    if (children.length > shown.length) {
      rows.push({
        name: `... ${children.length - shown.length} more`,
        kind: 'folder',
        relativePath: parent,
        children: undefined,
      })
    }

    return rows
  }

  return {
    name: rootName || 'Project Folder',
    children: walk('', 1),
  }
}

async function readBackendHealth() {
  try {
    const response = await fetch('/api/health')
    const body = await readResponseBody(response)

    return {
      ok: response.ok,
      status: response.status,
      body,
    }
  } catch (error) {
    return {
      ok: false,
      status: null,
      error: error instanceof Error ? error.message : 'Could not reach local backend.',
    }
  }
}

async function readResponseBody(response: Response) {
  const text = await response.text().catch(() => '')

  if (!text) {
    return null
  }

  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

function backendHealthModel(backendHealth: Awaited<ReturnType<typeof readBackendHealth>>) {
  if (backendHealth.body && typeof backendHealth.body === 'object' && 'model' in backendHealth.body && typeof backendHealth.body.model === 'string') {
    return backendHealth.body.model
  }

  return ''
}

function extractApiErrorMessage(value: unknown, status?: number) {
  if (status === 502 && (value === null || value === '' || (typeof value === 'string' && value.toLowerCase().includes('bad gateway')))) {
    return 'Local Project Porter API is offline. Keep `npm run dev` running, or start the API with `npm run dev:server`, then retry AI Review.'
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const error = typeof record.error === 'string' ? record.error : ''
    const details = typeof record.details === 'string' ? record.details : ''

    return [error, details].filter(Boolean).join(' ')
  }

  if (typeof value === 'string' && value.trim()) {
    return value.trim()
  }

  return ''
}

function errorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message
  }

  if (error instanceof DOMException) {
    return error.message
  }

  if (typeof error === 'string') {
    return error
  }

  try {
    return JSON.stringify(error)
  } catch {
    return 'Unknown error.'
  }
}

function serializeUnknownError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    }
  }

  if (error instanceof DOMException) {
    return {
      name: error.name,
      message: error.message,
      code: error.code,
    }
  }

  return error
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError'
}

function downloadTextFile(fileName: string, content: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')

  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
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

function useStoredOrganizationMode(key: string, initialValue: OrganizationMode) {
  const [value, setValue] = useState<OrganizationMode>(() => {
    const stored = localStorage.getItem(key)
    return stored === 'rules-only' || stored === 'rules-plus-ai-review' || stored === 'force-ai-debug' ? stored : initialValue
  })

  useEffect(() => {
    localStorage.setItem(key, value)
  }, [key, value])

  return [value, setValue] as const
}

function sumPlannedSize(items: ReviewPlanItem[], manifest: ManifestItem[]) {
  return items.reduce((total, item) => {
    const matching = manifest.filter((manifestItem) => isDescendantPath(manifestItem.relativePath, item.sourceRelativePath) && manifestItem.kind === 'file')
    return total + matching.reduce((sum, manifestItem) => sum + (manifestItem.sizeBytes ?? 0), 0)
  }, 0)
}

function buildApplyWorkSummary(
  planOperations: ReviewPlanItem[],
  selectedDeliverables: DeliverableCandidate[],
  copyDeliverables: boolean,
  manifest: ManifestItem[],
) {
  const manifestFiles = manifest.filter((item) => item.kind === 'file')
  const movedSourcePaths: string[] = []
  let totalFiles = 0
  let totalBytes = 0

  function addFile(item: ManifestItem) {
    totalFiles += 1
    totalBytes += item.sizeBytes ?? 0
  }

  for (const deliverable of selectedDeliverables) {
    const file = manifestFiles.find((item) => item.relativePath === deliverable.sourceRelativePath)

    if (file) {
      addFile(file)
    }

    if (!copyDeliverables) {
      movedSourcePaths.push(deliverable.sourceRelativePath)
    }
  }

  for (const operation of planOperations) {
    const files = manifestFiles.filter(
      (item) =>
        isDescendantPath(item.relativePath, operation.sourceRelativePath) &&
        !movedSourcePaths.some((movedPath) => isDescendantPath(item.relativePath, movedPath)),
    )

    for (const file of files) {
      addFile(file)
    }

    movedSourcePaths.push(operation.sourceRelativePath)
  }

  return { totalFiles, totalBytes }
}

export default App
