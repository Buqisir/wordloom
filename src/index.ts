import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createApp } from './app.js';
import { openDatabase } from './db.js';
import { listenHostFromEnv, listenPolicyFromEnv, listenPortFromEnv } from './protect.js';

const host = listenHostFromEnv(process.env);
const port = listenPortFromEnv(process.env);
const databasePath = process.env.DATABASE_PATH ?? resolve('data', 'wordloom.sqlite');
const policy = listenPolicyFromEnv(process.env);

mkdirSync(dirname(databasePath), { recursive: true });
const db = openDatabase(databasePath);
const server = createApp({
  db,
  secureCookies: policy.secureCookies,
  originPolicy: policy.originPolicy,
});
server.listen(port, host, () => {
  console.log(`wordloom listening on http://${host}:${port}`);
});
