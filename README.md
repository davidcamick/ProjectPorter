# Project Porter

Local-first project organizer for finished video-editing jobs. Project Porter runs in Chrome/Chromium, scans a source project folder with the File System Access API, asks a local Express backend for an OpenAI structured-output organization plan, lets you review everything, and then performs browser-side file moves with copy-verify-delete safety.

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create an environment file:

   ```bash
   cp .env.example .env
   ```

   Add your OpenAI API key:

   ```bash
   OPENAI_API_KEY=your_key_here
   ```

3. Start the Vite app and local API server:

   ```bash
   npm run dev
   ```

4. Open Chrome or Chromium at the URL printed by Vite, usually:

   ```text
   http://localhost:5173
   ```

## What Runs Where

- Frontend: React, Vite, TypeScript, Tailwind CSS.
- Browser file access: `window.showDirectoryPicker({ mode: "readwrite" })`.
- Backend: local Express server at `server/index.ts`.
- API endpoint: `POST /api/classify`.
- OpenAI key: read only by the backend from `.env`.
- Storage: temporary UI preferences only in `localStorage`.
- Database/auth/cloud services: none.

## Safety Model

Project Porter never uploads actual media files to the backend or OpenAI. The frontend sends only:

- file and folder names
- relative paths
- extensions
- sizes
- modified dates
- folder child counts and sample child names

The AI never performs file operations. It only returns a structured JSON plan. The user must review and approve before the browser writes anything.

Moves are implemented as:

1. Copy file/folder to the destination.
2. Verify file size or folder count/size as best as the browser API allows.
3. Delete the original only after copy verification succeeds.

Destination collisions are handled by appending `__2`, `__3`, and so on.

## MVP Flow

1. Select or drag in a source project folder.
2. Select a destination Projects folder, or choose organize in place.
3. Confirm project name, project date, and final folder name.
4. Scan the source folder.
5. Generate an AI plan, with deterministic fallback if the API is unavailable.
6. Review and edit every proposed operation, including nested extractions.
7. Select final deliverables and choose move or copy behavior.
8. Apply organization with live per-file progress.
9. Review the final tree and generated reports.

Reports are written into the organized project folder:

- `ORGANIZATION_REPORT.md`
- `ORGANIZATION_REPORT.json`

If an apply error occurs after the destination folder is created, Project Porter attempts to write:

- `ORGANIZATION_REPORT_FAILED.md`
- `ORGANIZATION_REPORT_FAILED.json`

## Mock Manifest Mode

Use **Load sample mock manifest** on the setup screen to test scanning, AI/fallback classification, review, deliverable selection, and preview UI without selecting a real folder. Mock mode is preview-only and does not write files.

## Scripts

```bash
npm run dev      # Vite frontend + local Express backend
npm run build    # TypeScript check + production build
npm run lint     # ESLint
```
