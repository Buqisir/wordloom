# Wordloom

Shared vocabulary accounts. Phone and desktop are two cookie sessions of one account. Progress lives in SQLite on the server. The React client uses Lism CSS for layout and a small stylesheet for the locked colors and type.

## Plan

- Fresh MIT server. Do not fork Vocably and do not copy AGPL code.
- One account, many sessions. Scheduling runs only on the server (`ts-fsrs`, fuzz off) so two devices cannot diverge.
- Separate word senses, source sentences, learner cards, and schedules. A review stores the original sentence and the chosen meaning.
- Review events are append-only. A practice review (`affectsSchedule: false`) is recorded and does not move the due date.
- Manual add, versioned JSON export, and replace or merge restore. Optional `eqbank` fields are stored metadata only. This server does not call Eqbank.
- Accounts use scrypt password hashes, HttpOnly session cookies, and CSRF tokens. Writes require an idempotency key and, for reviews, the schedule revision the client last saw.

## Run

Use the project directory that contains `package.json`. Node.js 22 or newer is required. Dependencies are not in the source archive; install them from the lockfiles. These npm commands are the same on Windows, macOS, and Linux:

```bash
npm ci
npm ci --prefix web
npm test
npm run build:web
```

`npm test` compiles the API with `tsc` and runs `node --test --test-concurrency=1 dist/test/api.test.js`. That includes the HTTP check that `Origin: http://127.0.0.1:5173` can use the explicit dev API policy. The test listens on an ephemeral port on `127.0.0.1`, so it does not need ports 8787 or 5173. It does not open a browser.

`npm run build:web` typechecks and builds the client with Vite. It does not start a server.

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

Unverified. The environment used to prepare this source archive blocks browser access to the local app, so the UI was not exercised in a browser here. That is not a ban on supported browsers. Where a supported browser can open `http://127.0.0.1:5173`, manual QA and `npm run test:ui` are available. Do not add `--no-sandbox` or any other flag that bypasses browser restrictions or security. This archive was checked with `npm test` and `npm run build:web` only.

## API

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/api/health` | `{ ok: true }` |
| GET | `/api/csrf` | One-time setup token in `wl_setup_csrf` |
| POST | `/api/auth/register` | 201, then `wl_session` (HttpOnly) and `wl_csrf` |
| POST | `/api/auth/login` | 200, same cookies |
| POST | `/api/auth/logout` | Revokes that session only |
| GET | `/api/auth/me` | User id, email, `progressRevision` |
| POST | `/api/cards` | New sense, or `senseId` plus another sentence |
| GET | `/api/cards`, `/api/cards/:id` | Card, sense, occurrence, schedule |
| POST | `/api/cards/:id/reviews` | Grade `again`, `hard`, `good`, or `easy` |
| GET | `/api/cards/:id/events` | Append-only history |
| GET | `/api/queue` | Due at or before the server clock |
| GET | `/api/senses` | Senses with their sentences |
| GET | `/api/backup` | Schema version 1 |
| POST | `/api/backup/restore` | `replace` (confirm `"replace"`) or `merge` |

Unsafe authenticated requests send `X-CSRF-Token` equal to `wl_csrf`. Card create, review, and restore also send `Idempotency-Key` (`8–80` letters, digits, `_`, or `-`). The same key and body returns the first response with `Idempotency-Replayed: true`. The same key and a different body returns `409 IDEMPOTENCY_CONFLICT`. A review whose `expectedScheduleRevision` is stale returns `409 REVISION_CONFLICT`. A cookie change from a disallowed origin returns `403 ORIGIN_REJECTED` and sets no cookie. A rate-limited auth or CSRF setup call returns `429 RATE_LIMITED` with `Retry-After` and sets no cookie.

Backup documents use `schemaVersion: 1`. A replace restore deletes that account's learning rows and idempotency keys, then inserts the snapshot. Replaying the same restore key does not delete work added after the first restore. Ids owned by another account are rejected before any delete.

Synthetic examples only. No dictionary corpus and no remote account service.
