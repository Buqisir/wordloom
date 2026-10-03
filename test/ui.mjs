import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { chromium } from 'playwright-core';

const root = new URL('..', import.meta.url).pathname;
const apiPort = 8791;
const webPort = 4174;
const base = `http://127.0.0.1:${webPort}`;
const password = 'correct-horse-battery';

let api;
let web;
let browser;
let tempDir;

describe('wordloom ui', { timeout: 300000 }, () => {
  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'wordloom-ui-'));
    await run('npm', ['run', 'build:web']);
    api = start('node', ['dist/src/index.js'], {
      PORT: String(apiPort),
      HOST: '127.0.0.1',
      DATABASE_PATH: join(tempDir, 'wordloom.sqlite'),
    });
    await waitForHttp(`http://127.0.0.1:${apiPort}/api/health`, api);
    web = start('npm', ['run', 'preview', '--prefix', 'web', '--', '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], {
      WORDLOOM_API: `http://127.0.0.1:${apiPort}`,
      WORDLOOM_WEB_PORT: String(webPort),
    });
    await waitForHttp(base, web);
    browser = await chromium.launch({
      executablePath: '/usr/bin/chromium',
      headless: true,
      args: ['--disable-dev-shm-usage'],
    });
  });

  after(async () => {
    await browser?.close();
    api?.kill();
    web?.kill();
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('uses the locked layout at 390px and on a desktop width', async () => {
    const page = await openPage({ width: 390, height: 844 });
    try {
      await register(page, email('phone'));
      await page.getByRole('link', { name: '添加', exact: true }).click();
      const bodyStyle = await page.evaluate(() => {
        const style = getComputedStyle(document.body);
        return { background: style.backgroundColor, image: style.backgroundImage, font: style.fontFamily };
      });
      assert.equal(bodyStyle.background, 'rgb(255, 255, 255)');
      assert.equal(bodyStyle.image, 'none');
      assert.match(bodyStyle.font, /system-ui|sans-serif/);
      const save = page.getByRole('button', { name: '保存到账户', exact: true });
      assert.equal(await save.evaluate((element) => getComputedStyle(element).backgroundColor), 'rgb(36, 100, 181)');
      const bottom = await page.getByRole('navigation', { name: '主导航' }).boundingBox();
      assert.ok(bottom);
      assert.ok(bottom.y > 700, `bottom nav y was ${bottom.y}`);
      const reviewLink = await page.getByRole('link', { name: '复习', exact: true }).boundingBox();
      assert.ok(reviewLink && reviewLink.height >= 44);

      await addCard(page, {
        lemma: 'harbor',
        partOfSpeech: 'noun',
        meaning: 'a sheltered place for ships',
        sentence: 'The harbor light was a thin line across the water.',
      });
      await page.getByRole('link', { name: '词库', exact: true }).click();
      await assertType(page);

      await page.setViewportSize({ width: 1280, height: 800 });
      const side = await page.getByRole('navigation', { name: '主导航' }).boundingBox();
      assert.ok(side);
      assert.ok(side.x < 40, `desktop nav x was ${side.x}`);
      assert.ok(side.y < 120, `desktop nav y was ${side.y}`);
      await assertType(page);
      await page.getByText('浏览器自带语音，不是授权的词典发音。').waitFor();
    } finally {
      await page.context().close();
    }
  });

  it('syncs two sessions and keeps a second account empty', async () => {
    const address = email('sync');
    const first = await openPage({ width: 1280, height: 800 });
    const second = await openPage({ width: 1280, height: 800 });
    const other = await openPage({ width: 1280, height: 800 });
    try {
      await register(first, address);
      await login(second, address);
      await second.getByRole('link', { name: '词库', exact: true }).click();
      await register(other, email('other'));
      await other.getByRole('link', { name: '词库', exact: true }).click();
      const sentence = 'The keel held the hull in line.';
      await addCard(first, {
        lemma: 'keel',
        partOfSpeech: 'noun',
        meaning: 'the spine of a ship',
        sentence,
      });
      await second.getByText(sentence).waitFor({ timeout: 15000 });
      assert.equal(await other.getByText(sentence).count(), 0);

      await first.getByRole('link', { name: '复习', exact: true }).click();
      await first.getByRole('button', { name: '显示释义', exact: true }).focus();
      await first.keyboard.press('Enter');
      await first.getByRole('button', { name: '忘记，1 分钟', exact: true }).waitFor();
      await first.getByRole('button', { name: '困难，6 分钟', exact: true }).waitFor();
      await first.getByRole('button', { name: '良好，10 分钟', exact: true }).waitFor();
      await first.getByRole('button', { name: '简单，8 天', exact: true }).waitFor();
      await first.getByRole('button', { name: '良好，10 分钟', exact: true }).click();
      await first.getByText('已保存到账户').waitFor();
      await second.getByRole('link', { name: '历史', exact: true }).click();
      await second.getByText('良好').waitFor({ timeout: 15000 });
      await second.getByText(sentence).waitFor();
      await second.getByText('义项：the spine of a ship').waitFor();
    } finally {
      await first.context().close();
      await second.context().close();
      await other.context().close();
    }
  });

  it('keeps an offline review idempotent, then restores it once online', async () => {
    const page = await openPage({ width: 1280, height: 800 });
    try {
      await register(page, email('offline'));
      const sentence = 'Water gathered in the bilge overnight.';
      await addCard(page, {
        lemma: 'bilge',
        partOfSpeech: 'noun',
        meaning: 'the lowest inner part of a hull',
        sentence,
      });
      await page.getByRole('link', { name: '复习', exact: true }).click();
      await page.getByRole('button', { name: '显示释义', exact: true }).click();
      await page.context().setOffline(true);
      await page.getByRole('button', { name: '良好，10 分钟', exact: true }).click();
      await page.getByRole('button', { name: '良好，10 分钟', exact: true }).click();
      await page.getByText('1 次写入还没送到服务器').waitFor();
      await page.context().setOffline(false);
      await page.getByText('已保存到账户').waitFor({ timeout: 15000 });
      await page.getByRole('link', { name: '历史', exact: true }).click();
      await page.getByText(sentence).waitFor();
      assert.equal(await page.getByText('良好', { exact: true }).count(), 1);

      await page.reload();
      await page.getByText(sentence).waitFor();
      await page.getByRole('button', { name: '退出', exact: true }).click();
      await page.getByRole('heading', { name: '登录', exact: true }).waitFor();
      await page.reload();
      await page.getByRole('heading', { name: '登录', exact: true }).waitFor();
      await page.getByText('目前只支持邮箱和密码。').waitFor();
    } finally {
      await page.context().close();
    }
  });

  it('retries one aborted review without writing a second event', async () => {
    const page = await openPage({ width: 1280, height: 800 });
    try {
      await register(page, email('retry'));
      await addCard(page, {
        lemma: 'wake',
        partOfSpeech: 'noun',
        meaning: 'the trail of water behind a boat',
        sentence: 'The wake spread out behind the ferry.',
      });
      let calls = 0;
      await page.route('**/api/cards/*/reviews', async (route) => {
        calls += 1;
        if (calls === 1) {
          await route.abort();
          return;
        }
        await route.continue();
      });
      await page.getByRole('link', { name: '复习', exact: true }).click();
      await page.getByRole('button', { name: '显示释义', exact: true }).click();
      await page.getByRole('button', { name: '简单，8 天', exact: true }).click();
      await page.getByText('已保存到账户').waitFor({ timeout: 15000 });
      await page.unroute('**/api/cards/*/reviews');
      await page.getByRole('link', { name: '历史', exact: true }).click();
      assert.equal(await page.getByText('简单', { exact: true }).count(), 1);
      assert.ok(calls >= 2);
    } finally {
      await page.context().close();
    }
  });

  it('previews a backup, rejects a bad schema, and restores over a later card', async () => {
    const page = await openPage({ width: 1280, height: 800 });
    const other = await openPage({ width: 1280, height: 800 });
    try {
      const address = email('backup');
      await register(page, address);
      await login(other, address);
      const sentence = 'The sounding line read six fathom.';
      await addCard(page, {
        lemma: 'fathom',
        partOfSpeech: 'noun',
        meaning: 'a unit of water depth',
        sentence,
      });
      await page.getByRole('link', { name: '词库', exact: true }).click();
      const downloadPromise = page.waitForEvent('download');
      await page.getByRole('button', { name: '下载备份', exact: true }).click();
      const download = await downloadPromise;
      const file = join(tempDir, 'backup.json');
      await download.saveAs(file);
      await addCard(page, {
        lemma: 'extra',
        partOfSpeech: 'adjective',
        meaning: 'added later and not part of the snapshot',
        sentence: 'An extra line arrived after the export.',
      });
      await page.getByRole('link', { name: '词库', exact: true }).click();
      await page.setInputFiles('#backup-file', file);
      await page.getByText('账户里有 2 张卡片，备份里有 1 张。').waitFor();
      await page.getByText('卡片：新 0，相同 1，不一致 0').waitFor();
      await page.getByRole('button', { name: '替换本账户学习记录', exact: true }).click();
      await page.getByRole('checkbox', { name: '我要替换本账户的学习记录' }).check();
      await page.getByRole('button', { name: '确认替换', exact: true }).click();
      await page.getByText('已保存到账户').waitFor();
      await page.getByText(sentence).waitFor();
      assert.equal(await page.getByText('An extra line arrived after the export.').count(), 0);
      await other.getByRole('link', { name: '词库', exact: true }).click();
      await other.getByText(sentence).waitFor({ timeout: 15000 });
      assert.equal(await other.getByText('An extra line arrived after the export.').count(), 0);

      const bad = join(tempDir, 'bad.json');
      await writeFile(bad, JSON.stringify({ schemaVersion: 2 }));
      await page.setInputFiles('#backup-file', bad);
      await page.getByText('SCHEMA_UNSUPPORTED').waitFor();
      assert.equal(await page.getByRole('button', { name: '替换本账户学习记录', exact: true }).isDisabled(), true);
      await page.getByText(sentence).waitFor();
    } finally {
      await page.context().close();
      await other.context().close();
    }
  });
});

async function openPage(viewport) {
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  return page;
}

async function register(page, address) {
  await page.goto(base);
  await page.getByRole('button', { name: '注册新账户', exact: true }).click();
  await page.getByLabel('邮箱').fill(address);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '注册', exact: true }).click();
  await page.getByRole('heading', { name: '复习', exact: true }).waitFor();
}

async function login(page, address) {
  await page.goto(base);
  await page.getByLabel('邮箱').fill(address);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('heading', { name: '复习', exact: true }).waitFor();
}

async function addCard(page, card) {
  await page.getByRole('link', { name: '添加', exact: true }).click();
  await page.getByLabel('词头').fill(card.lemma);
  await page.getByLabel('词性').fill(card.partOfSpeech);
  await page.getByLabel('释义').fill(card.meaning);
  await page.getByLabel('原句').fill(card.sentence);
  await page.getByRole('button', { name: '保存到账户', exact: true }).click();
  await page.getByText('已保存到账户').waitFor();
}

async function assertType(page) {
  const head = page.locator('.headword').first();
  await head.waitFor();
  const font = await head.evaluate((element) => {
    const style = getComputedStyle(element);
    return { family: style.fontFamily, size: style.fontSize, color: style.color };
  });
  assert.match(font.family, /Georgia/);
  assert.equal(font.size, '38px');
  assert.equal(font.color, 'rgb(26, 26, 26)');
  const sentence = page.locator('.sentence').first();
  assert.equal(await sentence.evaluate((element) => getComputedStyle(element).fontSize), '18px');
  const mark = page.locator('mark.target-word').first();
  assert.equal(await mark.evaluate((element) => getComputedStyle(element).backgroundColor), 'rgb(255, 247, 202)');
}

function email(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.com`;
}

function start(command, args, env) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', (chunk) => {
    process.stderr.write(chunk);
  });
  return child;
}

async function waitForHttp(url, child) {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < 30000) {
    if (child.exitCode !== null) {
      throw new Error(`${url} process exited ${child.exitCode}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok || response.status === 404) {
        return;
      }
      last = String(response.status);
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${url}: ${last}`);
}

async function run(command, args) {
  const child = start(command, args, {});
  const code = await new Promise((resolve) => child.on('exit', resolve));
  if (code !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${code}`);
  }
}
