import { z } from 'zod'
import { MOVE_CATEGORIES } from './types.ts'

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
    suggestedOnly: z.boolean().optional(),
  })
  .strict()

export const deterministicHintsSchema = z
  .object({
    plan: z.array(movePlanItemSchema),
    detectedApps: z.array(z.string()),
    warnings: z.array(z.string()),
  })
  .strict()

export const classifyRequestSchema = z
  .object({
    projectName: z.string().min(1),
    sourceRootName: z.string().min(1),
    manifest: z.array(manifestItemSchema),
    deterministicHints: deterministicHintsSchema,
  })
  .strict()

export const classifyResponseSchema = z
  .object({
    plan: z.array(movePlanItemSchema),
    detectedApps: z.array(z.string()),
    warnings: z.array(z.string()),
    summary: z.string().min(1),
  })
  .strict()
