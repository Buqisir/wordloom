# Dependency notices

Wordloom application code is MIT. See `LICENSE`. It was written for this project and does not copy AGPL-licensed Vocably code. This source archive does not vendor dependency trees. `npm ci` and `npm ci --prefix web` install them from the lockfiles. The copyright and permission notices below were checked against the installed packages at the pinned versions.

Runtime dependencies use this MIT permission notice:

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

- `ts-fsrs` 5.4.2, MIT License, Copyright (c) 2026 Open Spaced Repetition. Server-side scheduling. Fuzz is disabled so a grade has one schedule.
- `lism-css` 1.0.1, MIT License, Copyright (c) Loos, Inc. Layout primitives and tokens, imported as `lism-css/main.css` and `lism-css/react`. The app does not use `@lism-css/ui`. Labels, focus, keyboard behavior, and dialogs are implemented in Wordloom.
- `react` and `react-dom` 19.2.4, MIT License, Copyright (c) Meta Platforms, Inc. and affiliates.

Development-only, not part of the client bundle:

- `typescript` 7.0.2 for the API, Apache License 2.0, author Microsoft Corp.
- `typescript` 5.9.3 in `web/`, Apache License 2.0.
- `@types/node` 26.6.4, MIT License, Copyright (c) Microsoft Corporation.
- `vite` 7.3.6, MIT License, Copyright (c) 2019-present, VoidZero Inc. and Vite contributors. The published Vite package also bundles dependencies under BSD-2-Clause, CC0-1.0, ISC, and MIT.
- `@vitejs/plugin-react` 5.1.4, MIT License, Copyright (c) 2019-present, Yuxi (Evan) You and Vite contributors.
- `@types/react` 19.2.14 and `@types/react-dom` 19.2.3, MIT License, Copyright (c) Microsoft Corporation.
- `playwright-core` 1.56.1, Apache License 2.0, Copyright (c) Microsoft Corporation. It notes Apache-2.0 code derived from Puppeteer. Browser UI tests were not run for this archive because that environment blocks them. This is not a ban on supported browsers. Do not pass flags that bypass browser security. No browser binary is downloaded with this package.

SQLite is Node.js `node:sqlite` (`DatabaseSync`). There is no separate database driver package.

No paid service, account provider, or dictionary integration is included. `eqbank` fields are optional stored metadata for a future source. This server never calls Eqbank.
