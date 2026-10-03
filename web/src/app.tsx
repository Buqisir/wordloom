import { createContext, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Cluster, Container, Heading, Stack, WithSide } from 'lism-css/react';
import {
  classifyWriteFailure,
  SyncController,
  SyncError,
  type OutboxWrite,
  type SyncAccount,
  type SyncClassifier,
  type SyncStorage,
} from '../../src/clientSync.js';
import {
  ApiError,
  cookieValue,
  currentUser,
  explainError,
  loadBackup,
  loadLibrary,
  loginAccount,
  logoutAccount,
  readPending,
  registerAccount,
  request,
  setCsrf,
  writePending,
  type HistoryRow,
  type SenseDetail,
} from './api';
import { previewBackup, type BackupPreview } from './backupPreview';
import { gradeChoices, GRADE_LABEL } from './intervals';
import { RevealedTranslation, reviewIntervalHint } from './reviewPrompt';
import type { BackupDocument, GradeName, ItemJson, ReviewEventJson, UserJson } from '../../src/types.js';

type Model = {
  user: UserJson | null;
  booting: boolean;
  online: boolean;
  lastRead: string | null;
  readError: string | null;
  notice: string;
  recovery: string;
  pending: OutboxWrite[];
  dismiss: (key: string) => void;
  items: ItemJson[];
  queue: ItemJson[];
  senses: SenseDetail[];
  history: HistoryRow[];
  path: string;
  go: (path: string) => void;
  register: (email: string, password: string) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  createCard: (body: Record<string, unknown>) => Promise<void>;
  review: (cardId: string, grade: GradeName, revision: number) => Promise<'saved' | 'pending'>;
  restore: (mode: 'merge' | 'replace', document: BackupDocument) => Promise<void>;
  downloadBackup: () => Promise<void>;
  accountBackup: () => Promise<BackupDocument>;
};

const Context = createContext<Model | null>(null);

export function App() {
  const model = useWordloom();
  return (
    <Context.Provider value={model}>
      <a className="skip" href="#main">
        跳到内容
      </a>
      {model.booting ? <p className="status">正在读取账户。</p> : model.user ? <Shell /> : <Auth />}
    </Context.Provider>
  );
}

const classifier: SyncClassifier = {
  outcome(error: unknown) {
    if (error instanceof ApiError) {
      return classifyWriteFailure('http', error.status, error.code);
    }
    if (error instanceof SyncError) {
      return classifyWriteFailure('http', error.status, error.code);
    }
    const name = error instanceof Error ? error.name : '';
    if (name === 'ResponseReadError' || name === 'ResponsePayloadError') {
      return classifyWriteFailure('body-read');
    }
    if (name === 'NetworkError') {
      return classifyWriteFailure('network');
    }
    return classifyWriteFailure('network');
  },
  failure(error: unknown) {
    if (error instanceof ApiError) {
      return { code: error.code, message: explainError(error) };
    }
    if (error instanceof SyncError) {
      return { code: error.code, message: error.message };
    }
    return { code: 'REQUEST_FAILED', message: error instanceof Error ? error.message : '写入没有成功。' };
  },
};

function sessionStore(): SyncStorage {
  return {
    read(userId: string) {
      return readPending(userId).map((item) => ({
        ...item,
        ownerId: item.ownerId && item.ownerId.length > 0 ? item.ownerId : userId,
      }));
    },
    write: writePending,
  };
}

function toHistory(items: ItemJson[], events: ReviewEventJson[]): HistoryRow[] {
  const byCard = new Map(items.map((item) => [item.card.id, item]));
  return events
    .map((event) => {
      const item = byCard.get(event.cardId);
      return {
        ...event,
        lemma: item?.sense.lemma ?? '',
        meaning: item?.sense.meaning ?? '',
        sentence: item?.occurrence.sentence ?? '',
        partOfSpeech: item?.sense.partOfSpeech ?? '',
      };
    })
    .sort((left, right) => right.reviewedAt.localeCompare(left.reviewedAt) || right.id.localeCompare(left.id));
}

function accountOf(user: UserJson): SyncAccount {
  return { id: user.id, email: user.email, progressRevision: user.progressRevision };
}

function useWordloom(): Model {
  const [, setRevision] = useState(0);
  const [path, setPath] = useState(window.location.pathname);
  const controllerRef = useRef<SyncController<ItemJson, SenseDetail, ReviewEventJson> | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new SyncController(
      {
        currentUser: async () => accountOf(await currentUser()),
        loadLibrary: async (expectedOwnerId) => loadLibrary(expectedOwnerId),
        send: async (item) => {
          const result = await request(item.path, {
            method: 'POST',
            body: item.body,
            csrf: 'session',
            key: item.key,
            ownerId: item.ownerId,
          });
          return { replayed: result.replayed };
        },
      },
      sessionStore(),
      classifier,
      () => crypto.randomUUID(),
      {
        online: navigator.onLine,
        stamp,
        onChange: () => setRevision((value) => value + 1),
        lock: async (userId, run) => {
          if (typeof navigator.locks?.request === 'function') {
            await navigator.locks.request(`wordloom-flush-${userId}`, run);
            return;
          }
          await run();
        },
      },
    );
  }
  const controller = controllerRef.current;
  const view = controller.snapshot();
  const history = useMemo(() => toHistory(view.items, view.events), [view.items, view.events]);

  useEffect(() => {
    const sync = controllerRef.current;
    if (!sync) {
      return;
    }
    let stop = false;
    void (async () => {
      if (cookieValue('wl_csrf')) {
        setCsrf(cookieValue('wl_csrf'));
      }
      if (stop) {
        return;
      }
      await sync.boot(() => currentUser().then(accountOf));
    })();
    return () => {
      stop = true;
      sync.cancelBoot();
    };
  }, []);

  useEffect(() => {
    const sync = controllerRef.current;
    if (!sync) {
      return;
    }
    function onPop() {
      setPath(window.location.pathname);
    }
    function onOnline() {
      sync?.setOnline(true);
      void sync?.flush();
    }
    function onOffline() {
      sync?.setOnline(false);
    }
    window.addEventListener('popstate', onPop);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    const timer = window.setInterval(() => {
      sync.setOnline(navigator.onLine);
      void sync.poll(Date.now());
    }, 1500);
    return () => {
      window.removeEventListener('popstate', onPop);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.clearInterval(timer);
    };
  }, []);

  function go(next: string) {
    window.history.pushState({}, '', next);
    setPath(next);
  }

  async function enter(account: UserJson): Promise<void> {
    controller.adopt(accountOf(account));
    await controller.reload();
    const queued = controller.snapshot().pending.filter((item) => !item.failure).length;
    if (queued > 0) {
      controller.setNotice(`还有 ${queued} 次写入没送到服务器，会用原来的请求继续发送。`);
      await controller.flush();
    }
  }

  const model: Model = {
    user: view.user,
    booting: view.booting,
    online: view.online,
    lastRead: view.lastRead,
    readError: view.readError,
    notice: view.notice,
    recovery: view.recovery,
    pending: view.pending,
    items: view.items,
    queue: view.queue,
    senses: view.senses,
    history,
    path,
    go,
    dismiss(key) {
      controller.dismiss(key);
    },
    async register(email, password) {
      await enter(await registerAccount(email, password));
      go('/review');
    },
    async login(email, password) {
      await enter(await loginAccount(email, password));
      go('/review');
    },
    async logout() {
      const current = controller.snapshot().user?.id ?? null;
      await logoutAccount();
      controller.logoutLocal(current);
      go('/');
    },
    async createCard(body) {
      await controller.submit('/api/cards', body, '添加卡片');
    },
    async review(cardId, grade, revision) {
      const pathName = `/api/cards/${cardId}/reviews`;
      if (controller.blocksPath(pathName)) {
        controller.setNotice('这张卡片有一次评分还没送到服务器。');
        return 'pending';
      }
      const result = await controller.submit(pathName, { grade, affectsSchedule: true, expectedScheduleRevision: revision }, '复习评分');
      return result.pending ? 'pending' : 'saved';
    },
    async restore(mode, document) {
      await controller.submit('/api/backup/restore', mode === 'replace' ? { mode, confirm: 'replace', document } : { mode, document }, '导入备份');
    },
    async downloadBackup() {
      const document = await loadBackup();
      const url = URL.createObjectURL(new Blob([JSON.stringify(document, null, 2)], { type: 'application/json' }));
      const link = window.document.createElement('a');
      link.href = url;
      link.download = 'wordloom-backup.json';
      window.document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      controller.noteRead();
    },
    accountBackup: loadBackup,
  };
  return model;
}

function useApp(): Model {
  const model = useContext(Context);
  if (!model) {
    throw new Error('Wordloom 界面还没有准备好。');
  }
  return model;
}

function Shell() {
  const model = useApp();
  const page = pageFor(model.path);
  return (
    <Container>
      <WithSide className="shell" sideW="220px" g="0" isContainer>
        <Stack isSide className="side-nav" g="10">
          <p className="brand">Wordloom</p>
          <nav aria-label="主导航">
            <Stack g="5">
              <NavLinks />
            </Stack>
          </nav>
          <p className="account-email">{model.user?.email}</p>
          <button type="button" className="button" onClick={() => void model.logout()}>
            退出
          </button>
        </Stack>
        <div className="main-column">
          <Stack g="30">
            <div className="account-top">
              <Cluster g="10" ai="center">
                <p className="account-email">{model.user?.email}</p>
                <button type="button" className="button" onClick={() => void model.logout()}>
                  退出
                </button>
              </Cluster>
            </div>
            <StatusBar />
            <main id="main">{page}</main>
          </Stack>
        </div>
        <nav className="bottom-nav" aria-label="主导航">
          <NavLinks />
        </nav>
      </WithSide>
    </Container>
  );
}

function NavLinks() {
  const { path, go } = useApp();
  const links = [
    ['/add', '添加'],
    ['/review', '复习'],
    ['/library', '词库'],
    ['/history', '历史'],
  ] as const;
  return links.map(([href, label]) => (
    <a
      key={href}
      className="nav-link"
      href={href}
      aria-current={path === href ? 'page' : undefined}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
          return;
        }
        event.preventDefault();
        go(href);
      }}
    >
      {label}
    </a>
  ));
}

function pageFor(path: string): ReactNode {
  if (path === '/add') {
    return <AddPage />;
  }
  if (path === '/library') {
    return <LibraryPage />;
  }
  if (path === '/history') {
    return <HistoryPage />;
  }
  if (path === '/review' || path === '/') {
    return <ReviewPage />;
  }
  return (
    <Stack g="10">
      <Heading level="1" className="page-title">
        没有这个页面
      </Heading>
      <p>地址不在添加、复习、词库、历史里面。</p>
    </Stack>
  );
}

function StatusBar() {
  const model = useApp();
  const waiting = model.pending.filter((item) => !item.failure);
  const rejected = model.pending.filter((item) => item.failure);
  const parts = [model.online ? '在线' : '离线'];
  if (model.lastRead) {
    parts.push(`上次成功读取账户 ${model.lastRead}`);
  }
  if (model.user) {
    parts.push(`进度版本 ${model.user.progressRevision}`);
  }
  if (model.readError) {
    parts.push(`连接失败：${model.readError}。画面可能不是最新。`);
  }
  if (waiting.length > 0) {
    parts.push(`有 ${waiting.length} 次写入还没送到服务器，会用原来的请求重试。`);
  }
  if (model.notice) {
    parts.push(model.notice);
  }
  return (
    <Stack g="10">
      <p className="status" role="status">
        {parts.join('。')}
      </p>
      {rejected.map((item) => (
        <Cluster key={item.key} g="10" ai="center">
          <p className="error" role="alert">
            {item.label}没有写入。{item.failure?.message}
          </p>
          <button type="button" className="button" onClick={() => model.dismiss(item.key)}>
            不再保留
          </button>
        </Cluster>
      ))}
    </Stack>
  );
}

function Auth() {
  const model = useApp();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!error) {
      return;
    }
    if (!emailRef.current?.value) {
      emailRef.current?.focus();
      return;
    }
    passwordRef.current?.focus();
  }, [error]);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) {
      return;
    }
    const data = new FormData(event.currentTarget);
    const email = String(data.get('email') ?? '');
    const password = String(data.get('password') ?? '');
    setBusy(true);
    setError('');
    try {
      if (mode === 'register') {
        await model.register(email, password);
      } else {
        await model.login(email, password);
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? explainError(caught) : caught instanceof Error ? caught.message : '没有完成。');
    } finally {
      setBusy(false);
    }
  }

  const passwordHint = mode === 'login' ? '登录使用这个账户已经设置的密码。' : '注册密码需要 10 到 200 个字符，请用你能记住的一串字符。';
  const support = mode === 'login' ? '登录后，手机和电脑共用这一账户里的词和原句。' : '注册后，词和原句记在这个账户里，手机和电脑都能打开。';

  return (
    <Container>
      <main id="main" className="auth-screen">
        <WithSide className="auth-split" sideW="390px" mainW="460px" g="30" isContainer>
          <Stack isSide className="auth-form" g="20">
              <p className="brand">Wordloom</p>
              <Heading level="1" className="auth-title">
                {mode === 'login' ? '登录' : '注册'}
              </Heading>
              <p className="hint">{support}</p>
              {model.recovery ? (
                <p className="status" role="status">
                  {model.recovery}
                </p>
              ) : null}
              <form onSubmit={(event) => void onSubmit(event)}>
                <div className="auth-fields">
                  <div className="field">
                    <label htmlFor="email">邮箱</label>
                    <input
                      ref={emailRef}
                      id="email"
                      name="email"
                      type="email"
                      autoComplete="email"
                      required
                      maxLength={320}
                      aria-invalid={error ? true : undefined}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="password">密码</label>
                    <input
                      ref={passwordRef}
                      id="password"
                      name="password"
                      type="password"
                      autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                      required
                      minLength={10}
                      maxLength={200}
                      aria-describedby={error ? 'password-hint auth-error' : 'password-hint'}
                      aria-invalid={error ? true : undefined}
                    />
                    <p id="password-hint" className="hint">
                      {passwordHint}
                    </p>
                  </div>
                  {error ? (
                    <p id="auth-error" className="error" role="alert">
                      {error}
                    </p>
                  ) : null}
                  <button type="submit" className="button button-primary auth-submit" disabled={busy} aria-busy={busy}>
                    {busy ? (mode === 'login' ? '正在登录' : '正在注册') : mode === 'login' ? '登录' : '注册'}
                  </button>
                </div>
              </form>
              <button
                type="button"
                className="button auth-switch"
                onClick={() => {
                  setMode(mode === 'login' ? 'register' : 'login');
                  setError('');
                }}
                disabled={busy}
              >
                {mode === 'login' ? '注册新账户' : '改用登录'}
              </button>
          </Stack>
          <aside className="auth-preview" aria-label="词在原句里的样子">
            <Stack g="20">
              <p className="eyebrow">语境中的词</p>
              <p className="headword">harbor</p>
              <p className="meta">noun</p>
              <p className="meaning">可以停靠的港湾</p>
              <p className="sentence">
                The <mark className="target-word">harbor</mark> light marked a quiet channel.
              </p>
            </Stack>
          </aside>
        </WithSide>
      </main>
    </Container>
  );
}

function AddPage() {
  const model = useApp();
  const [senseId, setSenseId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const chosen = model.senses.find((sense) => sense.id === senseId);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const sentence = String(data.get('sentence') ?? '').trim();
    const translation = String(data.get('translation') ?? '').trim();
    const eqbank = readEqbank(data);
    const body: Record<string, unknown> = { sentence };
    if (translation) {
      body.sentenceTranslation = translation;
    }
    if (eqbank) {
      body.eqbank = eqbank;
    }
    if (senseId) {
      body.senseId = senseId;
    } else {
      body.lemma = String(data.get('lemma') ?? '').trim();
      body.partOfSpeech = String(data.get('partOfSpeech') ?? '').trim();
      body.meaning = String(data.get('meaning') ?? '').trim();
    }
    const form = event.currentTarget;
    setBusy(true);
    setError('');
    try {
      await model.createCard(body);
      form.reset();
      setSenseId('');
    } catch (caught) {
      setError(caught instanceof ApiError ? explainError(caught) : caught instanceof Error ? caught.message : '没有保存。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack className="reading-column" g="30">
      <Heading level="1" className="page-title">
        添加
      </Heading>
      <form onSubmit={(event) => void onSubmit(event)}>
        <Stack g="30">
          <div className="field">
            <label htmlFor="sense-id">记到已有义项</label>
            <select id="sense-id" value={senseId} onChange={(event) => setSenseId(event.target.value)}>
              <option value="">新建义项</option>
              {model.senses.map((sense) => (
                <option key={sense.id} value={sense.id}>
                  {sense.lemma} · {sense.partOfSpeech} · {sense.meaning}
                </option>
              ))}
            </select>
          </div>
          {chosen ? (
            <p className="meta">
              新原句会连到义项“{chosen.meaning}”。
            </p>
          ) : (
            <>
              <div className="field">
                <label htmlFor="lemma">词头</label>
                <input id="lemma" name="lemma" required maxLength={200} />
              </div>
              <div className="field">
                <label htmlFor="part-of-speech">词性</label>
                <input id="part-of-speech" name="partOfSpeech" required maxLength={64} />
              </div>
              <div className="field">
                <label htmlFor="meaning">释义</label>
                <textarea id="meaning" name="meaning" required maxLength={2000} />
              </div>
            </>
          )}
          <div className="field">
            <label htmlFor="sentence">原句</label>
            <textarea id="sentence" name="sentence" required maxLength={4000} />
          </div>
          <div className="field">
            <label htmlFor="translation">原句译文，可选</label>
            <textarea id="translation" name="translation" maxLength={4000} />
          </div>
          <details>
            <summary className="summary">来源标注，只保存，不连接 Eqbank</summary>
            <Stack g="10">
              <div className="field">
                <label htmlFor="eqbank-item">条目编号</label>
                <input id="eqbank-item" name="eqbankItem" maxLength={200} />
              </div>
              <div className="field">
                <label htmlFor="eqbank-source">来源名</label>
                <input id="eqbank-source" name="eqbankSource" maxLength={200} />
              </div>
              <div className="field">
                <label htmlFor="eqbank-locator">位置</label>
                <input id="eqbank-locator" name="eqbankLocator" maxLength={200} />
              </div>
            </Stack>
          </details>
          {error ? (
            <p className="error" role="alert">
              {error}
            </p>
          ) : null}
          <button type="submit" className="button button-primary" disabled={busy}>
            保存到账户
          </button>
        </Stack>
      </form>
    </Stack>
  );
}

function ReviewPage() {
  const model = useApp();
  const card = model.queue[0];
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const choices = useMemo(() => (card ? gradeChoices(card.schedule) : []), [card]);

  useEffect(() => {
    setRevealed(false);
  }, [card?.card.id]);

  if (!card) {
    return (
      <Stack className="review-column" g="30">
        <Heading level="1" className="page-title">
          复习
        </Heading>
        <p>现在没有到期的卡片。</p>
      </Stack>
    );
  }

  async function grade(gradeName: GradeName) {
    if (busy) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      await model.review(card.card.id, gradeName, card.schedule.revision);
    } catch (caught) {
      setError(caught instanceof ApiError ? explainError(caught) : caught instanceof Error ? caught.message : '没有评分。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack className="review-column" g="30">
      <Heading level="1" className="page-title">
        复习
      </Heading>
      <p className="meta">到期 {model.queue.length} 张。当前这一张在最上面。</p>
      <article className="card review-card">
        <Stack g="20">
          <h2 className="headword">{card.sense.lemma}</h2>
          <p className="meta">{card.sense.partOfSpeech}</p>
          <Sentence sentence={card.occurrence.sentence} lemma={card.sense.lemma} />
          <SpeechButton text={card.occurrence.sentence} />
          {revealed ? (
            <p className="meaning">义项：{card.sense.meaning}</p>
          ) : (
            <button type="button" className="button button-primary" onClick={() => setRevealed(true)}>
              显示释义
            </button>
          )}
          <RevealedTranslation revealed={revealed} sentenceTranslation={card.occurrence.sentenceTranslation} />
        </Stack>
      </article>
      {revealed ? (
        <Stack g="10">
          <p className="hint">{reviewIntervalHint}</p>
          <Cluster className="grade-strip" g="10">
            {choices.map((choice) => (
              <button
                key={choice.grade}
                type="button"
                className="button button-primary"
                disabled={busy}
                onClick={() => void grade(choice.grade)}
              >
                {choice.label}，{choice.interval}
              </button>
            ))}
          </Cluster>
        </Stack>
      ) : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
    </Stack>
  );
}

function LibraryPage() {
  const model = useApp();
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState<BackupPreview | null>(null);
  const [currentCards, setCurrentCards] = useState<number | null>(null);
  const [error, setError] = useState('');
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const needle = query.trim().toLowerCase();
  const visible = model.items.filter((item) => {
    if (!needle) {
      return true;
    }
    return [item.sense.lemma, item.sense.partOfSpeech, item.sense.meaning, item.occurrence.sentence]
      .join('\n')
      .toLowerCase()
      .includes(needle);
  });

  async function onFile(file: File | undefined) {
    setError('');
    setConfirmed(false);
    if (!file) {
      setPreview(null);
      return;
    }
    if (file.size > 2_000_000) {
      setPreview(null);
      setError('文件超过 2 MB，服务器不会接收。');
      return;
    }
    try {
      const current = await model.accountBackup();
      setCurrentCards(current.cards.length);
      setPreview(previewBackup(await file.text(), current));
    } catch (caught) {
      setPreview(null);
      setError(caught instanceof ApiError ? explainError(caught) : caught instanceof Error ? caught.message : '没有读到备份。');
    }
  }

  async function commit(mode: 'merge' | 'replace') {
    if (!preview?.document) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      await model.restore(mode, preview.document);
      setPreview(null);
      setReplaceOpen(false);
      setConfirmed(false);
    } catch (caught) {
      setError(caught instanceof ApiError ? explainError(caught) : caught instanceof Error ? caught.message : '没有导入。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Stack g="30">
      <Heading level="1" className="page-title">
        词库
      </Heading>
      <div className="field">
        <label htmlFor="library-search">搜索词库</label>
        <input id="library-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      <p className="meta">显示 {visible.length} 张卡片。</p>
      {visible.length === 0 ? <p>{model.items.length === 0 ? '词库是空的。' : '没有符合的卡片。'}</p> : null}
      {visible.map((item) => (
        <LinkedCard key={item.card.id} item={item} />
      ))}
      <Cluster g="10">
        <button type="button" className="button" onClick={() => void model.downloadBackup()}>
          下载备份
        </button>
      </Cluster>
      <div className="field">
        <label htmlFor="backup-file">备份文件</label>
        <input
          id="backup-file"
          type="file"
          accept="application/json,.json"
          onChange={(event) => void onFile(event.target.files?.[0])}
        />
      </div>
      {preview ? (
        <section className="card" aria-label="导入预览">
          <Stack g="8">
            <Heading level="2" className="page-title">
              导入预览
            </Heading>
            <p>{preview.message}</p>
            <p>
              账户里有 {currentCards ?? model.items.length} 张卡片，备份里有 {preview.document?.cards.length ?? 0} 张。
            </p>
            <p>{countLine('义项', preview.senses)}</p>
            <p>{countLine('原句', preview.occurrences)}</p>
            <p>{countLine('卡片', preview.cards)}</p>
            <p>{countLine('日程', preview.schedules)}</p>
            <p>{countLine('复习记录', preview.reviewEvents)}</p>
            <p>不同编号但原句和释义相同：{preview.sameSentence}</p>
            <p className="hint">上面的数字是预览。合并或替换才会写入账户。</p>
            <Cluster g="10">
              <button
                type="button"
                className="button button-primary"
                disabled={!preview.ok || busy || preview.cards.conflict + preview.senses.conflict + preview.occurrences.conflict > 0}
                onClick={() => void commit('merge')}
              >
                合并导入
              </button>
              <button type="button" className="button" disabled={!preview.ok || busy} onClick={() => setReplaceOpen(true)}>
                替换本账户学习记录
              </button>
            </Cluster>
          </Stack>
        </section>
      ) : null}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      <Dialog open={replaceOpen} title="替换本账户学习记录" onClose={() => setReplaceOpen(false)}>
        <Stack g="12">
          <p>替换会删除本账户现有的学习记录，再写入这份备份。其他账户不受影响。</p>
          <label className="check">
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
            我要替换本账户的学习记录
          </label>
          <Cluster g="10">
            <button type="button" className="button button-primary" disabled={!confirmed || busy} onClick={() => void commit('replace')}>
              确认替换
            </button>
            <button type="button" className="button" onClick={() => setReplaceOpen(false)}>
              取消
            </button>
          </Cluster>
        </Stack>
      </Dialog>
    </Stack>
  );
}

function HistoryPage() {
  const { history } = useApp();
  return (
    <Stack g="30">
      <Heading level="1" className="page-title">
        历史
      </Heading>
      {history.length === 0 ? <p>还没有复习记录。</p> : null}
      {history.map((event) => (
        <article key={event.id} className="card card-row">
          <Stack g="10">
            <h2 className="list-headword">{event.lemma}</h2>
            <p className="meta">{event.partOfSpeech}</p>
            <Sentence sentence={event.sentence} lemma={event.lemma} />
            <p className="meaning">义项：{event.meaning}</p>
            <p>
              <time dateTime={event.reviewedAt}>{new Date(event.reviewedAt).toLocaleString('zh-CN', { hour12: false })}</time>
              {' · '}
              {GRADE_LABEL[event.grade]}
              {' · '}
              {event.affectsSchedule ? `到期改为 ${event.dueAfter}` : '没有改日程'}
            </p>
          </Stack>
        </article>
      ))}
    </Stack>
  );
}

function LinkedCard({ item }: { item: ItemJson }) {
  return (
    <article className="card card-row">
      <Stack g="10">
        <div className="library-line">
          <div>
            <h2 className="list-headword">{item.sense.lemma}</h2>
            <p className="meta">{item.sense.partOfSpeech}</p>
          </div>
          <p className="meaning">义项：{item.sense.meaning}</p>
          <p className="meta">到期 {formatWhen(item.schedule.due)}</p>
        </div>
        <Sentence sentence={item.occurrence.sentence} lemma={item.sense.lemma} />
      </Stack>
    </article>
  );
}

function Sentence({ sentence, lemma }: { sentence: string; lemma: string }) {
  return (
    <p className="sentence">
      {splitHighlight(sentence, lemma).map((part, index) =>
        part.hit ? (
          <mark key={index} className="target-word">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </p>
  );
}

function SpeechButton({ text }: { text: string }) {
  const [note, setNote] = useState('浏览器自带语音，不是授权的词典发音。');
  return (
    <Stack g="5">
      <button
        type="button"
        className="button"
        onClick={() => {
          const synth = window.speechSynthesis;
          if (!synth) {
            setNote('这台浏览器没有朗读功能。');
            return;
          }
          synth.cancel();
          const utter = new SpeechSynthesisUtterance(text);
          utter.lang = 'en-US';
          synth.speak(utter);
          setNote('正在用浏览器自带语音朗读，不是授权的词典发音。');
        }}
      >
        浏览器朗读
      </button>
      <p className="hint">{note}</p>
    </Stack>
  );
}

function Dialog({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useRef(`dialog-${crypto.randomUUID()}`);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) {
      return;
    }
    if (open && !dialog.open) {
      dialog.showModal();
      dialog.querySelector<HTMLElement>('button, [href], input, select, textarea')?.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId.current}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <Stack g="12">
        <Heading level="2" id={titleId.current} className="page-title">
          {title}
        </Heading>
        {children}
      </Stack>
    </dialog>
  );
}

function countLine(label: string, count: { fresh: number; same: number; conflict: number }): string {
  return `${label}：新 ${count.fresh}，相同 ${count.same}，不一致 ${count.conflict}`;
}

function readEqbank(data: FormData): { itemId: string | null; source: string | null; locator: string | null } | null {
  const itemId = String(data.get('eqbankItem') ?? '').trim();
  const source = String(data.get('eqbankSource') ?? '').trim();
  const locator = String(data.get('eqbankLocator') ?? '').trim();
  if (!itemId && !source && !locator) {
    return null;
  }
  return { itemId: itemId || null, source: source || null, locator: locator || null };
}

function splitHighlight(sentence: string, lemma: string): Array<{ text: string; hit: boolean }> {
  const needle = lemma.trim();
  if (!needle) {
    return [{ text: sentence, hit: false }];
  }
  const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig');
  const parts: Array<{ text: string; hit: boolean }> = [];
  let last = 0;
  for (const match of sentence.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) {
      parts.push({ text: sentence.slice(last, index), hit: false });
    }
    parts.push({ text: match[0] ?? '', hit: true });
    last = index + (match[0]?.length ?? 0);
  }
  if (last < sentence.length) {
    parts.push({ text: sentence.slice(last), hit: false });
  }
  return parts.length > 0 ? parts : [{ text: sentence, hit: false }];
}

function formatWhen(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return value;
  }
  return new Date(parsed).toLocaleString('zh-CN', { hour12: false });
}

function stamp(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}
