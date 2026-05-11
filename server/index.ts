import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import OpenAI from 'openai'
import { zodTextFormat } from 'openai/helpers/zod'
import { classifyRequestSchema, classifyResponseSchema } from '../shared/schemas.ts'
import type { ClassifyResponse } from '../shared/types.ts'

dotenv.config()

const app = express()
const port = Number(process.env.PORT ?? 8787)
const model = process.env.OPENAI_MODEL ?? 'gpt-5.2'
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null

app.use(cors({ origin: ['http://localhost:5173', 'http://127.0.0.1:5173'] }))
app.use(express.json({ limit: '25mb' }))

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
    response.status(503).json({
      error: 'OPENAI_API_KEY is not configured. The frontend should use deterministic fallback rules.',
    })
    return
  }

  const { projectName, sourceRootName, manifest, deterministicHints } = parsed.data
  const topLevelItems = manifest.filter((item) => !item.relativePath.includes('/'))

  const instructions = [
    'You are organizing a finished video-editing project for a local-first browser utility.',
    'Classify source files/folders into only: Project Files, Raw, Assets, Exports, Deliverables, _Needs Review, Ignore.',
    'Return a move plan for movable source items. Prefer top-level folders, but include nested files/folders when they clearly live in the wrong top-level category.',
    'Examples: Assets inside Project Files should move to Assets; Footage inside Assets should move to Raw; music loose inside Project Files should move to Assets/_Loose Assets; project files mixed inside a generic Project Files folder should move into the correct app folder.',
    'If a parent folder is being unpacked because some children move elsewhere, do not also move that parent as a whole. Instead preserve only the remaining immediate children under the appropriate destination.',
    'Do not create duplicate top-level folders like Assets__2 or Project Files__2 in the plan. Merge/preserve children under the canonical top-level folder paths.',
    'Do not treat numbered image sequence frames or linked-comp fill folders inside Project Files as loose assets; preserve those folders under Project Files.',
    'If a child would naturally move along with a parent folder to the same destination path, do not include that child separately.',
    'If you include a nested extraction and the parent still has valid remaining contents, you may also include the parent; the frontend applies nested moves before parent moves.',
    'Prefer preserving existing folders and grouping. Do not flatten project folders.',
    'Do not create unnecessary subfolders.',
    'Do not invent iPhone, GoPro, Sony, A7, FX3, or similar camera folders unless that grouping already exists in the source.',
    'Project Files may contain Premiere, After Effects, Photoshop, or Illustrator folders, but only when matching files or folders are detected.',
    'Raw should contain actual footage and existing footage groupings.',
    'Assets should contain existing assets, cache, music, graphics, SFX, fonts, LUTs, thumbnails, overlays, and image/audio support material.',
    'Exports should contain drafts, renders, review files, social versions, and exported-looking media.',
    'Deliverables should only be final files explicitly selected by the user. Usually classify likely finals as Exports with suggestedOnly true and explain that the user must confirm them.',
    'Ambiguous files/folders go to _Needs Review.',
    'Never output absolute paths, paths starting with slash, or paths containing ..',
    'Never output paths outside the destination project folder.',
    'Use collision-safe, human-readable relative destination paths.',
    'For Ignore items, leave destinationRelativePath empty.',
    'Return only valid structured JSON.',
  ].join('\n')

  const input = {
    projectName,
    sourceRootName,
    topLevelItems,
    manifest,
    deterministicHints,
    destinationTopLevelFolders: ['Project Files', 'Raw', 'Assets', 'Exports', 'Deliverables'],
    projectFolderRules: {
      projectFiles: 'Use Project Files/Premiere, Project Files/After Effects, Project Files/Photoshop, Project Files/Illustrator only when matching app files/folders exist.',
      looseMedia: 'Loose root video files without export wording go to Raw/_Loose Media.',
      looseExports: 'Loose root exported-looking video files go to Exports/_Loose Exports unless the user later selects them as deliverables.',
      looseAssets: 'Loose root audio, image, font, LUT, or design-support files go to Assets/_Loose Assets.',
      needsReview: 'Zip files, unknown root folders, unknown files, and low-confidence items require review.',
    },
  }

  try {
    const completion = await openai.responses.parse({
      model,
      instructions,
      input: JSON.stringify(input),
      text: {
        format: zodTextFormat(classifyResponseSchema, 'project_porter_classification'),
      },
    })

    const output = completion.output_parsed

    if (!output) {
      throw new Error('The model returned no parsed classification output.')
    }

    const validated: ClassifyResponse = classifyResponseSchema.parse(output)
    response.json(validated)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown OpenAI classification error.'
    response.status(502).json({
      error: 'AI classification failed. The frontend should use deterministic fallback rules.',
      details: message,
    })
  }
})

app.listen(port, () => {
  console.log(`Project Porter API listening on http://localhost:${port}`)
})
