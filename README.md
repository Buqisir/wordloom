# Wordloom

Shared vocabulary accounts. Phone and desktop are two cookie sessions of one account. Progress lives in SQLite on the server. The React client uses Lism CSS for layout and a small stylesheet for the locked colors and type.

## Plan

- Fresh MIT server. Do not fork Vocably and do not copy AGPL code.
- One account, many sessions. Scheduling runs only on the server (FSRS 6, package `ts-fsrs` 5.4.2, fuzz off) so two devices cannot diverge.
- Separate word senses, source sentences, learner cards, and schedules. A review stores the original sentence and the chosen meaning.
- Review events are append-only. A practice review (`affectsSchedule: false`) is recorded and does not move the due date.
- Manual add, versioned JSON export, and replace or merge restore. Optional `eqbank` fields are stored metadata only. This server does not call Eqbank.
- Accounts use scrypt password hashes, HttpOnly session cookies, and CSRF tokens. Writes require an idempotency key and, for reviews, the schedule revision the client last saw.
- One recognition schedule is shared by every sentence of one explicit sense. Sentences keep their own text. A new sense gets its own schedule.

## Recognition schedules

Extra sentences on a sense you already chose do not reset its review progress. Review shows one of those sentences. The index moves to the next sentence only when a recognition grade is newly saved. Practice, reload, and a repeated saved request do not move it. Other sentences, and every sentence translation, stay hidden until you reveal the card.

A backup file is schema 2. It lists the recognition tasks, the shared schedules, the older per-card schedules, and which sentence is current. A schema 1 file can still be restored. The server turns it into the same recognition tasks. A backup does not include idempotency keys. Copying the file to another server does not replay or cancel requests that were already saved on the first server.

Opening a version 1 or 2 SQLite file with this build migrates it to version 3 in one transaction. Back up that file first. The migration keeps every old per-card schedule and copies one whole schedule forward: the earliest due date, then the lowest card id. It does not add the old schedules together. A review still waiting in the outbox with an old per-card revision comes back as a conflict and stays in the outbox. Do not point this build at a database that another process already has open.

Merging a backup accepts an existing recognition task only when the whole task snapshot matches. The shared schedule revision may differ after this server rebases it. Added sentences, a sentence already stored on that sense but missing from the backup, archived schedules, review history, or a different current sentence are refused, and that merge does not change the account. A repeated merge of the same snapshot does not move progress.

Replacing a backup keeps the recognition revision floor. If a sense comes back with no card and you later add its first sentence, the new schedule starts one revision above that floor. A sense that never had a schedule still starts at revision 1.

## Run

Use the project directory that contains `package.json`. Node.js 22 or newer is required. Dependencies are not in the source archive; install them from the lockfiles. These npm commands are the same on Windows, macOS, and Linux:

```bash
npm ci
npm ci --prefix web
npm test
npm run build:web
```

`npm test` compiles the API with `tsc` and runs `node --test --test-concurrency=1 dist/test/api.test.js dist/test/clientSync.test.js dist/test/senseRecognition.test.js`. That includes the HTTP check that `Origin: http://127.0.0.1:5173` can use the explicit dev API policy. The test listens on an ephemeral port on `127.0.0.1`, so it does not need ports 8787 or 5173. One case renders the review translation component with `react-dom/server`. The suite does not open a browser. `npm run test:ui` is a separate script and is not part of `npm test`.

`npm run build:web` typechecks and builds the client with Vite. It does not start a server.

## Continuous integration

`.github/workflows/ci.yml` runs on pull requests whose base branch is `main`, and on pushes to `main` and `fix/**`. The job uses the `ubuntu-24.04` GitHub-hosted runner. It checks the repository out without persisting credentials, then installs Node.js `24.21.0`. On 2026-10-03 that release is the current Node.js 24 Krypton LTS in the official Node.js index, and its official build includes npm `11.19.0`. The workflow requires those two versions, then installs from `package-lock.json` and `web/package-lock.json`.

With Node.js 24.21.0 and npm 11.19.0 first on `PATH`, the job is:

```bash
npm ci
npm ci --prefix web
npm test
npm run build:web
```

The checkpoint before this workflow was 49 passing Node tests, then `npm run build:web`. That count is 49, not 47. The 49 tests include the HTTP checks and the `react-dom/server` component render. They are not automated browser tests. `npm run test:ui` is not in the workflow and has not been run. The Firefox notes under Manual browser QA are historical manual evidence.

A later independent check of this tree used Node.js 24.21.0 and npm 11.19.0. `npm test` reported 76 tests, 15 suites, 0 failed, and 0 skipped. `npm run build:web` transformed 106 modules. That check is separate from the 49-test checkpoint above and is not a result from `.github/workflows/ci.yml`. `npm run test:ui` was not run. The Firefox notes for that check are under Later synthetic checks.

`npm start` listens on `127.0.0.1:8787` and opens `data/wordloom.sqlite` when `HOST`, `PORT`, and `DATABASE_PATH` are unset. With `WORDLOOM_ALLOWED_ORIGINS` unset, a loopback listener accepts any loopback `http` or `https` origin (`127.0.0.1`, `localhost`, `::1`, any port). A non-loopback `HOST` is refused unless `WORDLOOM_PUBLIC_REVIEWED=1`. `NODE_ENV=production`, and any public listener, also require `WORDLOOM_SECURE_COOKIES=1` and a non-empty `WORDLOOM_ALLOWED_ORIGINS` list of exact `http` or `https` origins. Those checks stay in place for the Vite dev pair. A production deployment is not reviewed.

Cookie-changing routes require an allowed `Origin`. If `Origin` is absent, a `Referer` origin is used. `Origin: null` is rejected and does not fall through to `Referer`. Auth writes are limited to 40 per 15 minutes per socket address, and CSRF setup to 80 per 15 minutes. Logout shares the auth limit. A rejected origin does not count. The limiter uses the socket address, not `X-Forwarded-For`.

## Local API on 8787 and Vite on 5173

Run the API and Vite as two processes from the project directory. Leave `NODE_ENV`, `WORDLOOM_SECURE_COOKIES`, and `WORDLOOM_PUBLIC_REVIEWED` unset. Build the API before starting it, because the server runs `dist/src/index.js`.

The dev pair uses these values:

| Variable | Value |
| --- | --- |
| `HOST` | `127.0.0.1` |
| `PORT` | `8787` |
| `WORDLOOM_ALLOWED_ORIGINS` | `http://127.0.0.1:5173` |
| `WORDLOOM_API` | `http://127.0.0.1:8787` |

```bash
npm run build
npm run start:dev
```

`npm run start:dev` sets `HOST`, `PORT`, and `WORDLOOM_ALLOWED_ORIGINS` to the table above and runs `node dist/src/index.js`. npm invokes that script through a shell. If the shell does not accept `NAME=value` prefixes, set the same three variables in the environment and run `node dist/src/index.js`.

The API binds `127.0.0.1:8787`, stores data in `data/wordloom.sqlite`, and allows only the origin `http://127.0.0.1:5173`. Cookies are not marked `Secure`, because this page is HTTP. `http://localhost:5173` is a different origin and is rejected. If port 8787 is already taken, stop the other listener or choose another `PORT` and point `WORDLOOM_API` at that origin.

```bash
npm run dev --prefix web
```

Set `WORDLOOM_API` only when the API is not at `http://127.0.0.1:8787`. Vite binds `127.0.0.1:5173` with `strictPort`, so it exits if that port is taken. Its `/api` proxy uses `changeOrigin: false`, so the browser `Origin` is forwarded unchanged. Open `http://127.0.0.1:5173`.

`npm test` covers this pair over HTTP. The test reads the `start:dev` script and resolves it with the same parser as `src/index.ts`, then listens on an ephemeral `127.0.0.1` port. Requests use `Origin: http://127.0.0.1:5173`. The same run checks that `NODE_ENV=production` still refuses this dev environment without `WORDLOOM_SECURE_COOKIES=1`, and that a production allow-list of `https://words.example` rejects the Vite origin.

`npm run preview --prefix web` serves the production build on `127.0.0.1` and port `WORDLOOM_WEB_PORT` (default 4173). Add that exact origin to `WORDLOOM_ALLOWED_ORIGINS` before using preview with an explicit allow-list.

## Manual browser QA

The notes in this section are historical manual evidence from Firefox. They are not a result from `.github/workflows/ci.yml` and not a run of `npm run test:ui`.

Firefox on this machine opened `http://127.0.0.1:5173` for the checks below. That Firefox is a supported browser for this app. Managed Chromium still blocks loopback access; leave that block in place. Do not add `--no-sandbox` or any other flag that bypasses browser restrictions or security. `npm run test:ui` was not run for this pass.

Auth and basic learning in that Firefox session: the desktop auth form at about 1188px; login and register at 390×844 with the preview hidden and no horizontal clipping; an empty submit stopped on the required email and returned focus there; keyboard order was email, password, submit, then the mode switch, with a visible focus ring; Enter switched modes. A synthetic local account saved one card. The library showed that card’s part of speech, meaning, and sentence. Review revealed the meaning and the four grade choices. At 390px those grades were a 2×2 grid above the bottom navigation. Stopping the API left one review pending and the screen usable; after the API was started again, the retry cleared that write, moved the account revision, and took the card out of the due queue. History showed that one review. The same card came back on its own when its due time arrived, with no refresh and no further grade. A second tab in the same Firefox profile showed a later grade and the new revision on its own. That check is same-browser, same-account sync.

Node regressions are a separate run. That pass recorded `npm test` with 49 passing tests and `npm run build:web`. Those commands do not open a browser.

Unchecked in the browser after that pass: the `test:ui` script, a cross-account race on screen, backup restore in the UI, speech output, a review whose response body is lost after the server has committed it, and two independent devices.

## Later synthetic checks

The 76-test check above rereviewed backup export as one transaction and the refusal of a merge that would omit a sentence already stored on that sense. It reloaded the API from this build and repeated export and replace in Firefox on a disposable database. The original database was preserved.

That Firefox pass used synthetic data. An existing sense with two sentences stayed one recognition task. The same spelling saved as a new sense stayed separate. A recognition grade moved the prompt from 1/2 to 2/2. At 390px, reveal and the grade choices were used. Stopping the API left a grade queued; after the API returned, the retry saved it and history showed that grade on that sentence. The library showed a schema 2 export, its preview, a merge that changed nothing, and replace with that same file. Cancel and Escape each cleared the replace confirmation. Opening replace again left the checkbox unchecked and the confirm button disabled.

Still unchecked in the browser: the `test:ui` script, a cross-account race on screen, speech output, a review whose response body is lost after the server has committed it, and two independent devices.

## API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/health` | `{ ok: true }` |
| GET | `/api/csrf` | One-time setup token in `wl_setup_csrf` |
| POST | `/api/auth/register` | 201, then `wl_session` (HttpOnly) and `wl_csrf` |
| POST | `/api/auth/login` | 200, same cookies |
| POST | `/api/auth/logout` | Revokes that session only |
| GET | `/api/auth/me` | User id, email, `progressRevision` |
| GET | `/api/library` | One snapshot: user, cards, due queue, senses, and review events. Requires `X-Wordloom-Owner` |
| POST | `/api/cards` | New sense, or `senseId` plus another sentence |
| GET | `/api/cards`, `/api/cards/:id` | Card, sense, occurrence, schedule |
| POST | `/api/cards/:id/reviews` | Grade `again`, `hard`, `good`, or `easy` |
| GET | `/api/cards/:id/events` | Append-only history |
| GET | `/api/queue` | Due at or before the server clock |
| GET | `/api/senses` | Senses with their sentences |
| GET | `/api/backup` | Schema version 2 export |
| POST | `/api/backup/restore` | Accepts schema 1 or 2. `replace` (confirm `"replace"`) or `merge` |

Unsafe authenticated requests send `X-CSRF-Token` equal to `wl_csrf`. Card create, review, and restore also send `Idempotency-Key` (`8–80` letters, digits, `_`, or `-`) and `X-Wordloom-Owner` set to the account id that queued the write. Inside that write transaction the server re-reads the session and returns `409 OWNER_MISMATCH` when the header is a different account, or `400 VALIDATION` when the header is missing. The same key and body returns the first response with `Idempotency-Replayed: true`. The same key and a different body returns `409 IDEMPOTENCY_CONFLICT`. A review whose `expectedScheduleRevision` is stale returns `409 REVISION_CONFLICT`. A cookie change from a disallowed origin returns `403 ORIGIN_REJECTED` and sets no cookie. A rate-limited auth or CSRF setup call returns `429 RATE_LIMITED` with `Retry-After` and sets no cookie.

`GET /api/backup` exports `schemaVersion: 2`. The file lists recognition tasks, one shared schedule per task, the older per-card schedules, and which sentence is current. Restore accepts `schemaVersion: 1` or `schemaVersion: 2`. A version 1 file has one schedule per card, and the server turns it into the same recognition tasks. A replace restore deletes that account's learning rows, keeps idempotency receipts, and keeps the shared-task generation floor and the alias floors. The alias floors are the revision retained for each card that belonged to the task, and the binding that keeps that card on that task. The restore then inserts the snapshot. `progressRevision` becomes one greater than both the live revision and the snapshot revision. Each restored shared schedule keeps the snapshot's due time and FSRS fields. Its `revision` is set above the snapshot revision, the review revisions stored for that task, and those shared-task and alias floors. The floors survive deleting the card, so a later replace cannot revive a revision an uncommitted review still expects. A version 1 file does not carry those floors. A fresh server uses the revisions inside the file. A server that already has the floors applies them at insert. Replaying a key whose write already committed does not apply it again, including after a later replace. Ids owned by another account are rejected before any delete. The client applies `GET /api/library` only when that snapshot's user is the account named by `X-Wordloom-Owner`.

Synthetic examples only. No dictionary corpus and no remote account service.
