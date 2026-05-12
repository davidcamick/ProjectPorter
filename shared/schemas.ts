import { z } from 'zod'
import { MOVE_CATEGORIES } from './types.ts'

export const organizationModeSchema = z.enum(['rules-only', 'rules-plus-ai-review', 'force-ai-debug'])

export const manifestItemSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    relativePath: z.string().min(1),
    kind: z.enum(['file', 'folder']),
    extension: z.string().nullable(),
    sizeBytes: z.number().nonnegative().nullable(),
    modifiedAt: z.string().nullable(),
    childCount: z.number().int().nonnegative().optional(),
    sampleChildren: z.array(z.string()).optional(),
    hiddenSystem: z.boolean().optional(),
  })
  .strict()

export const moveCategorySchema = z.enum(MOVE_CATEGORIES)

export const movePlanItemSchema = z
  .object({
    id: z.string().min(1),
    sourceRelativePath: z.string().min(1),
    destinationRelativePath: z.string(),
    category: moveCategorySchema,
    confidence: z.number().min(0).max(1),
    reason: z.string().min(1),
    requiresReview: z.boolean(),
    source: z.literal('rules').optional().default('rules'),
    operation: z.enum(['move', 'delete']).optional(),
    preserveDestinationRelativePath: z.string().optional(),
    suggestedOnly: z.boolean().optional(),
    aiReviewed: z.boolean().optional(),
  })
  .strict()

export const deterministicHintsSchema = z
  .object({
    plan: z.array(movePlanItemSchema),
    detectedApps: z.array(z.string()),
    warnings: z.array(z.string()),
  })
  .strict()

export const aiReviewOverrideSchema = z
  .object({
    id: z.string().min(1),
    action: z.enum(['keep', 'change_destination', 'mark_needs_review', 'ignore']),
    destinationRelativePath: z.string().nullable(),
    category: moveCategorySchema.nullable(),
    confidence: z.number().min(0).max(1),
    reason: z.string().min(1),
  })
  .strict()

export const aiReviewResponseSchema = z
  .object({
    summary: z.string().min(1),
    overrides: z.array(aiReviewOverrideSchema).max(250),
    warnings: z.array(z.string()),
    recommendedUserQuestions: z.array(z.string()),
  })
  .strict()

export const deterministicPlanSummarySchema = z
  .object({
    totalItems: z.number().int().nonnegative(),
    enabledItems: z.number().int().nonnegative(),
    needsReviewItems: z.number().int().nonnegative(),
    byCategory: z.record(moveCategorySchema, z.number().int().nonnegative()),
    lowConfidenceItems: z.number().int().nonnegative(),
  })
  .strict()

export const rootFolderSummarySchema = z
  .object({
    totalRootItems: z.number().int().nonnegative(),
    files: z.number().int().nonnegative(),
    folders: z.number().int().nonnegative(),
    canonicalFoldersPresent: z.array(z.string()),
    variantCanonicalFolders: z.array(
      z
        .object({
          name: z.string(),
          canonicalName: z.string(),
          relativePath: z.string(),
        })
        .strict(),
    ),
  })
  .strict()

export const compactAiSettingsSchema = z
  .object({
    maxAiItems: z.number().int().positive().max(1000),
    maxSampleChildrenPerFolder: z.number().int().nonnegative().max(100),
    maxAiPayloadBytes: z.number().int().positive().max(2_000_000),
  })
  .strict()

const candidateBaseSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    relativePath: z.string().min(1),
    deterministicDestination: z.string(),
    deterministicConfidence: z.number().min(0).max(1),
    deterministicReason: z.string().min(1),
    whySentToAi: z.array(z.string()),
  })
  .strict()

export const aiReviewFolderCandidateSchema = candidateBaseSchema.extend({
  kind: z.literal('folder'),
  childCount: z.number().int().nonnegative(),
  totalFileCount: z.number().int().nonnegative(),
  totalFolderCount: z.number().int().nonnegative(),
  totalSizeBytes: z.number().nonnegative(),
  extensionCounts: z.record(z.string(), z.number().int().nonnegative()),
  topLevelSampleChildren: z.array(z.string()),
  detectedAppsInside: z.array(z.string()),
  containsVideo: z.boolean(),
  containsAudio: z.boolean(),
  containsProjectFiles: z.boolean(),
  containsCache: z.boolean(),
  containsExports: z.boolean(),
  containsImages: z.boolean(),
  containsArchives: z.boolean(),
  maxDepth: z.number().int().nonnegative(),
})

export const aiReviewFileCandidateSchema = candidateBaseSchema.extend({
  kind: z.literal('file'),
  extension: z.string().nullable(),
  sizeBytes: z.number().nonnegative().nullable(),
  modifiedAt: z.string().nullable(),
})

export const aiReviewCandidateSchema = z.discriminatedUnion('kind', [aiReviewFolderCandidateSchema, aiReviewFileCandidateSchema])

export const aiReviewGroupedSummarySchema = z
  .object({
    id: z.string().min(1),
    kind: z.literal('group'),
    parentPath: z.string(),
    extension: z.string().nullable(),
    namePattern: z.string(),
    count: z.number().int().positive(),
    deterministicDestination: z.string(),
    deterministicConfidenceRange: z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)]),
    whySentToAi: z.array(z.string()),
    sampleNames: z.array(z.string()),
  })
  .strict()

export const classifyRequestSchema = z
  .object({
    projectName: z.string().min(1),
    projectDate: z.string().min(1),
    sourceRootName: z.string().min(1),
    mode: z.enum(['in-place', 'import']),
    organizationMode: organizationModeSchema,
    deterministicPlanSummary: deterministicPlanSummarySchema,
    rootFolderSummary: rootFolderSummarySchema,
    detectedApps: z.array(z.string()),
    folderCandidates: z.array(aiReviewFolderCandidateSchema),
    ambiguousItems: z.array(aiReviewCandidateSchema),
    suspiciousItems: z.array(aiReviewCandidateSchema),
    deliverableCandidates: z.array(aiReviewFileCandidateSchema),
    groupedSummaries: z.array(aiReviewGroupedSummarySchema),
    validationWarningsBeforeApply: z.array(z.string()),
    aiSettings: compactAiSettingsSchema,
    aiEstimatedTokenRisk: z.enum(['low', 'medium', 'high']),
    compacted: z.boolean(),
    warnings: z.array(z.string()),
  })
  .strict()

export const classifyResponseSchema = aiReviewResponseSchema.extend({
  detectedApps: z.array(z.string()).optional().default([]),
  model: z.string().optional(),
  usage: z.unknown().optional(),
})
