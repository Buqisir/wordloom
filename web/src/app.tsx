import { createContext, useContext, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Cluster, Heading, Stack, WithSide } from 'lism-css/react';
import {
  ApiError,
  NetworkError,
  clearPending,
  cookieValue,
  currentUser,
  explainError,
  loadBackup,
  loadHistory,
  loadLibrary,
  loginAccount,
  logoutAccount,
  readPending,
  registerAccount,
  request,
  setCsrf,
  writePending,
  type HistoryRow,
  type PendingWrite,
  type SenseDetail,
} from './api';
import { previewBackup, type BackupPreview } from './backupPreview';
import { gradeChoices, GRADE_LABEL } from './intervals';
import type { BackupDocument, GradeName, ItemJson, UserJson } from '../../src/types.js';

type Model = {
  user: UserJson | null;
  booting: boolean;
  online: boolean;
  lastRead: string | null;
  readError: string | null;
  notice: string;
  pending: PendingWrite[];
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

function useWordloom(): Model {
  const [user, setUser] = useState<UserJson | null>(null);
  const [booting, setBooting] = useState(true);
  const [online, setOnline] = useState(navigator.onLine);
  const [lastRead, setLastRead] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [pending, setPending] = useState<PendingWrite[]>([]);
  const [items, setItems] = useState<ItemJson[]>([]);
  const [queue, setQueue] = useState<ItemJson[]>([]);
  const [senses, setSenses] = useState<SenseDetail[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  const [path, setPath] = useState(window.location.pathname);
  const userRef = useRef(user);
  const progressRef = useRef(0);
  const flushing = useRef(false);
  userRef.current = user;

  async function reload(nextUser = userRef.current): Promise<void> {
    if (!nextUser) {
      return;
    }
    const library = await loadLibrary();
    const events = await loadHistory(library.items);
    setItems(library.items);
    setQueue(library.queue);
    setSenses(library.senses);
    setHistory(events);
    setLastRead(stamp());
    setReadError(null);
    progressRef.current = nextUser.progressRevision;
  }

  function remember(userId: string, entry: PendingWrite): void {
    const current = readPending(userId);
    const next = current.some((item) => item.key === entry.key) ? current : [...current, entry];
    writePending(userId, next);
    setPending(next);
  }

  function forget(userId: string, key: string): void {
    const next = readPending(userId).filter((item) => item.key !== key);
    writePending(userId, next);
    setPending(next);
  }

  async function submitWrite(pathName: string, body: unknown, label: string): Promise<{ pending: boolean; replayed: boolean }> {
    const current = userRef.current;
    if (!current) {
      throw new ApiError(401, 'UNAUTHENTICATED', '需要登录。');
    }
    const signature = JSON.stringify(body);
    const existing = readPending(current.id).find((item) => item.path === pathName && JSON.stringify(item.body) === signature);
    const entry = existing ?? { key: crypto.randomUUID(), path: pathName, body, label };
    if (!navigator.onLine) {
      remember(current.id, entry);
      setOnline(false);
      setNotice('还没送到服务器。');
      return { pending: true, replayed: false };
    }
    try {
      const result = await request(pathName, { method: 'POST', body, csrf: 'session', key: entry.key });
      forget(current.id, entry.key);
      const refreshed = await currentUser();
      setUser(refreshed);
      progressRef.current = refreshed.progressRevision;
      await reload(refreshed);
      setNotice(result.replayed ? '服务器返回了上次同一请求的结果，没有再次写入。' : '已保存到账户。');
      return { pending: false, replayed: result.replayed };
    } catch (error) {
      if (error instanceof NetworkError) {
        remember(current.id, entry);
        setReadError(error.message);
        setNotice('还没送到服务器。');
        return { pending: true, replayed: false };
      }
      throw error;
    }
  }

  async function flush(): Promise<void> {
    const current = userRef.current;
    if (!current || flushing.current || !navigator.onLine) {
      return;
    }
    const queueItems = readPending(current.id);
    if (queueItems.length === 0) {
      return;
    }
    flushing.current = true;
    const remain: PendingWrite[] = [];
    let stop = false;
    try {
      for (const item of queueItems) {
        if (stop) {
          remain.push(item);
          continue;
        }
        try {
          const result = await request(item.path, { method: 'POST', body: item.body, csrf: 'session', key: item.key });
          setNotice(result.replayed ? '服务器返回了上次同一请求的结果，没有再次写入。' : '已保存到账户。');
        } catch (error) {
          if (error instanceof NetworkError || (error instanceof ApiError && error.status >= 500)) {
            remain.push(item);
            stop = true;
            setReadError(error instanceof NetworkError ? error.message : error.message);
            continue;
          }
          if (error instanceof ApiError && error.status === 401) {
            clearPending(current.id);
            setPending([]);
            setUser(null);
            setNotice(explainError(error));
            return;
          }
          setNotice(error instanceof ApiError ? explainError(error) : '写入没有成功。');
        }
      }
      writePending(current.id, remain);
      setPending(remain);
      if (remain.length !== queueItems.length) {
        const refreshed = await currentUser();
        setUser(refreshed);
        await reload(refreshed);
      }
    } finally {
      flushing.current = false;
    }
  }

  useEffect(() => {
    let cancel = false;
    void (async () => {
      if (cookieValue('wl_csrf')) {
        setCsrf(cookieValue('wl_csrf'));
      }
      try {
        const signedIn = await currentUser();
        if (cancel) {
          return;
        }
        setUser(signedIn);
        progressRef.current = signedIn.progressRevision;
        setPending(readPending(signedIn.id));
        await reload(signedIn);
      } catch (error) {
        if (cancel) {
          return;
        }
        if (error instanceof ApiError && error.status === 401) {
          setUser(null);
        } else {
          setReadError(error instanceof Error ? error.message : '没能读取账户。');
        }
      } finally {
        if (!cancel) {
          setBooting(false);
        }
      }
    })();
    return () => {
      cancel = true;
    };
  }, []);

  useEffect(() => {
    function onPop() {
      setPath(window.location.pathname);
    }
    function onOnline() {
      setOnline(true);
      void flush();
    }
    function onOffline() {
      setOnline(false);
    }
    window.addEventListener('popstate', onPop);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    const timer = window.setInterval(() => {
      setOnline(navigator.onLine);
      if (!navigator.onLine || !userRef.current) {
        return;
      }
      void (async () => {
        if (readPending(userRef.current?.id ?? '').length > 0) {
          await flush();
          return;
        }
        try {
          const next = await currentUser();
          setLastRead(stamp());
          setReadError(null);
          setUser(next);
          if (next.progressRevision !== progressRef.current) {
            progressRef.current = next.progressRevision;
            await reload(next);
            setNotice('进度版本已更新。');
          }
        } catch (error) {
          if (error instanceof NetworkError) {
            setReadError(error.message);
          } else if (error instanceof ApiError && error.status === 401) {
            setUser(null);
          }
        }
      })();
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

  const model: Model = {
    user,
    booting,
    online,
    lastRead,
    readError,
    notice,
    pending,
    items,
    queue,
    senses,
    history,
    path,
    go,
    async register(email, password) {
      const signedIn = await registerAccount(email, password);
      setUser(signedIn);
      progressRef.current = signedIn.progressRevision;
      setPending(readPending(signedIn.id));
      await reload(signedIn);
      go('/review');
    },
    async login(email, password) {
      const signedIn = await loginAccount(email, password);
      setUser(signedIn);
      progressRef.current = signedIn.progressRevision;
      setPending(readPending(signedIn.id));
      await reload(signedIn);
      go('/review');
    },
    async logout() {
      const current = userRef.current;
      await logoutAccount();
      if (current) {
        clearPending(current.id);
      }
      setPending([]);
      setUser(null);
      setItems([]);
      setQueue([]);
      setSenses([]);
      setHistory([]);
      setNotice('');
      go('/');
    },
    async createCard(body) {
      await submitWrite('/api/cards', body, '添加卡片');
    },
    async review(cardId, grade, revision) {
      const current = userRef.current;
      const pathName = `/api/cards/${cardId}/reviews`;
      if (current && readPending(current.id).some((item) => item.path === pathName)) {
        setNotice('这张卡片有一次评分还没送到服务器。');
        return 'pending';
      }
      const result = await submitWrite(pathName, { grade, affectsSchedule: true, expectedScheduleRevision: revision }, '复习评分');
      return result.pending ? 'pending' : 'saved';
    },
    async restore(mode, document) {
      await submitWrite('/api/backup/restore', mode === 'replace' ? { mode, confirm: 'replace', document } : { mode, document }, '导入备份');
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
      setLastRead(stamp());
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
    <WithSide className="shell" sideW="220px" g="0">
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
        <Stack g="15">
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
  if (model.pending.length > 0) {
    parts.push(`有 ${model.pending.length} 次写入还没送到服务器，会用原来的请求重试。`);
  }
  if (model.notice) {
    parts.push(model.notice);
  }
  return (
    <p className="status" role="status">
      {parts.join('。')}
    </p>
  );
}

function Auth() {
  const model = useApp();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
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

  return (
    <main id="main" className="main-column">
      <Stack g="15">
        <Heading level="1" className="page-title">
          {mode === 'login' ? '登录' : '注册'}
        </Heading>
        <p className="hint">目前只支持邮箱和密码。</p>
        <form onSubmit={(event) => void onSubmit(event)}>
          <Stack g="12">
            <div className="field">
              <label htmlFor="email">邮箱</label>
              <input id="email" name="email" type="email" autoComplete="username" required maxLength={320} />
            </div>
            <div className="field">
              <label htmlFor="password">密码</label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                required
                minLength={10}
                maxLength={200}
                aria-describedby="password-hint"
              />
            </div>
            <p id="password-hint" className="hint">
              10 到 200 个字符。
            </p>
            {error ? (
              <p className="error" role="alert">
                {error}
              </p>
            ) : null}
            <button type="submit" className="button button-primary" disabled={busy}>
              {mode === 'login' ? '登录' : '注册'}
            </button>
          </Stack>
        </form>
        <button type="button" className="button" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
          {mode === 'login' ? '注册新账户' : '改用登录'}
        </button>
      </Stack>
    </main>
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
    <Stack g="15">
      <Heading level="1" className="page-title">
        添加
      </Heading>
      <form onSubmit={(event) => void onSubmit(event)}>
        <Stack g="12">
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
      <Stack g="10">
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
    <Stack g="15">
      <Heading level="1" className="page-title">
        复习
      </Heading>
      <article className="card">
        <Stack g="12">
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
          {card.occurrence.sentenceTranslation ? <p className="meta">译文：{card.occurrence.sentenceTranslation}</p> : null}
        </Stack>
      </article>
      {revealed ? (
        <Stack g="10">
          <p className="hint">间隔用与服务器相同的 FSRS 5.4.2 计算，模糊已关闭。点下去以后，以服务器保存的到期时间为准。</p>
          <Cluster g="10">
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
    <Stack g="15">
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
    <Stack g="15">
      <Heading level="1" className="page-title">
        历史
      </Heading>
      {history.length === 0 ? <p>还没有复习记录。</p> : null}
      {history.map((event) => (
        <article key={event.id} className="card">
          <Stack g="8">
            <h2 className="headword">{event.lemma}</h2>
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
    <article className="card">
      <Stack g="8">
        <h2 className="headword">{item.sense.lemma}</h2>
        <p className="meta">{item.sense.partOfSpeech}</p>
        <Sentence sentence={item.occurrence.sentence} lemma={item.sense.lemma} />
        <p className="meaning">义项：{item.sense.meaning}</p>
        <p className="meta">
          到期 {item.schedule.due} · 日程版本 {item.schedule.revision}
        </p>
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

function stamp(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}
