import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import OpenAI from 'openai'
import { zodTextFormat } from 'openai/helpers/zod'
import { aiReviewResponseSchema, classifyRequestSchema } from '../shared/schemas.ts'
import type { AiClassifyResponse } from '../shared/types.ts'

dotenv.config()

const app = express()
const port = Number(process.env.PORT ?? 8787)
const model = process.env.OPENAI_MODEL ?? 'gpt-5.2'
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null

app.use(cors({ origin: ['http://localhost:5173', 'http://127.0.0.1:5173'] }))
app.use(express.json({ limit: '1mb' }))

app.get('/api/health', (_request, response) => {
  response.json({ ok: true, model, hasApiKey: Boolean(process.env.OPENAI_API_KEY) })
})

app.post('/api/classify', async (request, response) => {
  const parsed = classifyRequestSchema.safeParse(request.body)

  if (!parsed.success) {
    response.status(400).json({
      error: 'Invalid classification request.',
      details: parsed.error.flatten(),
    })
    return
  }

  if (!openai) {
    response.status(503).json({ error: 'AI is enabled but OPENAI_API_KEY is missing.' })
    return
  }

  const packet = parsed.data
  const itemCount =
    new Set([
      ...packet.folderCandidates.map((item) => item.id),
      ...packet.ambiguousItems.map((item) => item.id),
      ...packet.suspiciousItems.map((item) => item.id),
      ...packet.deliverableCandidates.map((item) => item.id),
    ]).size + packet.groupedSummaries.reduce((sum, group) => sum + group.count, 0)

  const instructions = [
    'You are a lightweight reviewer for Project Porter, a local-first browser utility for video-editing project folders.',
    'The deterministic Smart Rules planner has already created the full move plan locally.',
    'You receive only compact summaries and ambiguous/problematic candidates. You do not receive media contents, binary data, or the full deep tree.',
    'Return corrections/overrides only for the supplied candidate IDs. Do not return a full move plan.',
    'Allowed categories are only: Project Files, Raw, Assets, Exports, Deliverables, _Needs Review, Ignore.',
    'Use Deliverables only as a suggestion requiring user confirmation. Prefer Exports for likely final/render media unless the UI says the user selected it.',
    'Cache and preview files are deleted by default in the frontend unless the user chooses to preserve cache files.',
    'Sidecars and index files that are not cache should stay with Assets.',
    'Premiere preview/cache folders never belong in Project Files. Media Cache never belongs in Raw.',
    'Loose camera-original-looking videos belong directly in Raw. Loose asset files belong directly in Assets. Loose render/export/linked-comp-looking videos belong in Exports/_Renders or Exports/_Loose Exports.',
    'If unsure between Raw and Exports, mark the item needs review.',
    'Canonical top-level folders are Project Files, Raw, Assets, Exports, Deliverables. Never suggest Assets__2, Exports__2, Raw__2, Deliverables__2, or Project Files__2.',
    'Do not invent app or camera subfolders. Preserve source grouping unless a candidate is clearly misplaced.',
    'Never output absolute paths, paths starting with slash, or paths containing ..',
    'Never output paths outside the destination project folder.',
    'Every override must include destinationRelativePath and category. Use null for fields that do not apply.',
    'For keep actions, preserve the deterministic decision and set destinationRelativePath/category to null unless you need to clarify the category.',
    'For change_destination, provide a relative destinationRelativePath and category.',
    'For ignore actions, set destinationRelativePath and category to null.',
    'Return only valid structured JSON.',
  ].join('\n')

  const input = {
    ...packet,
    aiCandidateCount: itemCount,
    destinationTopLevelFolders: ['Project Files', 'Raw', 'Assets', 'Exports', 'Deliverables'],
  }

  try {
    const completion = await openai.responses.parse({
      model,
      instructions,
      input: JSON.stringify(input),
      text: {
        format: zodTextFormat(aiReviewResponseSchema, 'project_porter_ai_review'),
      },
    })

    const output = completion.output_parsed

    if (!output) {
      throw new Error('The model returned no parsed classification output.')
    }

    const validated = aiReviewResponseSchema.parse(output)
    const payload: AiClassifyResponse = {
      ...validated,
      detectedApps: packet.detectedApps,
      model,
      usage: completion.usage,
    }
    response.json(payload)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown OpenAI classification error.'
    response.status(502).json({
      error: 'AI review failed.',
      details: message,
    })
  }
})

app.listen(port, () => {
  console.log(`Project Porter API listening on http://localhost:${port}`)
})
