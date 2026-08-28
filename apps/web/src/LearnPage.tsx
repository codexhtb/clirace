import { ArrowRight, BookOpen, Check, CheckCircle2, ChevronRight, CircleAlert, LoaderCircle, Map as MapIcon, RotateCcw, Terminal, X } from 'lucide-react';
import { type FormEvent, useEffect, useMemo, useState } from 'react';
import { CommunityHeader } from './CommunityHeader';
import { currentUser } from './auth-client';
import { humanizeError } from './errors';
import { learningDifficulty, learningQuestionType, practiceHrefForWeakArea } from './product-ux';
import { Link } from 'react-router-dom';

type LearningMode = 'quick' | 'standard' | 'full' | 'topic';
type Stat = { answered: number; correct: number; accuracy: number; sufficientData: boolean };
type Catalog = {
  course: { slug: string; title: string; description: string };
  totalQuestions: number;
  categories: { slug: string; count: number }[];
  modes: { id: LearningMode; title: string; questions: number | null; available: boolean }[];
  progress: { answered: number; correct: number; categories: Record<string, Stat>; concepts: Record<string, Stat> } | null;
};
type LearnSession = {
  id: string;
  course: string;
  mode: LearningMode;
  category?: string | null;
  status: 'active' | 'completed';
  progress?: { current: number; total: number; answered: boolean };
  question?: {
    slug: string; category: string; concept: string; difficulty: 'easy' | 'medium' | 'hard';
    type: 'single_choice' | 'multiple_choice' | 'scenario' | 'command_output';
    text: string; answers: { id: string; text: string }[];
  };
  feedback?: {
    isCorrect: boolean; selectedAnswerIds: string[]; correctAnswerIds: string[];
    explanation: string; selectedAnswerExplanation: string | null; shellPracticeChallengeSlug: string | null;
  };
  result?: {
    correct: number; total: number; percent: number;
    categories: Record<string, Stat>; concepts: Record<string, Stat>;
    strongAreas: string[]; weakAreas: string[];
  };
};

const categoryNames: Record<string, string> = {
  filesystem: 'Файловая система', permissions: 'Права доступа', processes: 'Процессы', users_groups: 'Пользователи и группы',
  networking: 'Сети', storage: 'Хранилище', systemd: 'systemd', logs: 'Логи', packages: 'Пакеты', bash: 'Bash', ssh: 'SSH',
  cron: 'Cron', signals: 'Сигналы', pipes_redirection: 'Pipes и перенаправление', environment: 'Окружение', troubleshooting: 'Диагностика',
};

export function LearnPage({ catalogOnly = false }: { catalogOnly?: boolean }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [auth, setAuth] = useState<'loading' | 'guest' | 'ready'>('loading');
  const [session, setSession] = useState<LearnSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      currentUser(),
      fetch('/api/learn/linux-core', { signal: controller.signal }).then(readJson<Catalog>),
    ]).then(async ([authPayload, catalogPayload]) => {
      setCatalog(catalogPayload);
      setAuth(authPayload.user ? 'ready' : 'guest');
      if (authPayload.user && !catalogOnly) {
        const response = await fetch('/api/learn/sessions/current', { signal: controller.signal });
        if (response.ok) setSession(await response.json() as LearnSession | null);
      }
    }).catch((reason) => {
      if (reason.name !== 'AbortError') setError(humanizeError(reason, 'Не удалось загрузить Linux Core.'));
    }).finally(() => setAuth((value) => value === 'loading' ? 'guest' : value));
    return () => controller.abort();
  }, [catalogOnly]);

  const request = async (url: string, body?: unknown) => {
    setBusy(true); setError(null);
    try {
      const options: RequestInit = body === undefined
        ? { method: 'POST' }
        : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
      const response = await fetch(url, options);
      const payload = await response.json() as LearnSession & { message?: string };
      if (!response.ok) throw new Error(payload.message ?? 'Не удалось продолжить обучение.');
      setSession(payload);
    } catch (reason) {
      setError(humanizeError(reason, 'Не удалось продолжить обучение.'));
    } finally { setBusy(false); }
  };

  return (
    <div className="learn-page min-h-screen bg-ink text-slate-200">
      <div className="grid-noise fixed inset-0 pointer-events-none" />
      <CommunityHeader />
      <main className="page-width relative z-10 py-10 sm:py-16">
        {catalogOnly ? <CourseCatalog catalog={catalog} error={error} />
          : auth === 'loading' || !catalog ? <Loading />
            : session?.status === 'active' && session.question && session.progress
              ? <QuestionScreen session={session} busy={busy} error={error} onRequest={request} />
              : session?.status === 'completed' && session.result
                ? <ResultScreen session={session} busy={busy} onStart={(mode, category) => request('/api/learn/sessions', { mode, ...(category ? { category } : {}) })} />
                : <CourseStart catalog={catalog} auth={auth} busy={busy} error={error} onStart={(mode, category) => request('/api/learn/sessions', { mode, ...(category ? { category } : {}) })} />}
      </main>
    </div>
  );
}

function CourseCatalog({ catalog, error }: { catalog: Catalog | null; error: string | null }) {
  return <section>
    <p className="eyebrow">CLIRace Learn</p>
    <h1 className="learn-hero-title">Учитесь понимать.<br /><span>Потом ускоряйтесь.</span></h1>
    <p className="learn-lead">Выберите формат: быстрые проверки знаний или последовательный путь с теорией, командами и настоящими shell-лабораторными.</p>
    {error && <p className="play-error mt-6" role="alert">{error}</p>}
    <div className="learn-course-grid">
      <Link className="learn-course-card featured" to="/learn/paths/linux-zero-to-operator">
        <span className="mode-card-icon"><MapIcon size={18} /></span><small>Главный курс · для новичка</small>
        <h2>Linux с нуля</h2><p>68 коротких уроков: объяснение → пример → вопросы → настоящая практика в shell.</p>
        <strong>Начать с первой команды <ArrowRight size={15} /></strong>
      </Link>
      <Link className="learn-course-card" to="/learn/paths/linux-foundations">
        <span className="mode-card-icon"><MapIcon size={18} /></span><small>Классический путь</small>
        <h2>Linux Foundations</h2><p>Существующий курс из 10 модулей — весь прежний прогресс сохранён.</p>
        <strong>Открыть курс <ArrowRight size={15} /></strong>
      </Link>
      <Link className="learn-course-card" to="/learn/linux-core">
        <span className="mode-card-icon"><Terminal size={18} /></span><small>Быстрая проверка</small>
        <h2>Linux Core</h2><p>Проверьте знания по отдельным темам и разберите каждый ответ.</p>
        <strong>{catalog ? `${catalog.totalQuestions} вопросов` : 'Загружаем…'} <ArrowRight size={15} /></strong>
      </Link>
      <Link className="learn-course-card" to="/interview"><span className="mode-card-icon"><BookOpen size={18} /></span><small>Проверка навыков</small><h2>Interview 100</h2><p>Сто практических задач для подготовки к Linux и DevOps собеседованию.</p><strong>Открыть коллекцию <ArrowRight size={15} /></strong></Link>
    </div>
  </section>;
}

function CourseStart({ catalog, auth, busy, error, onStart }: { catalog: Catalog; auth: 'guest' | 'ready'; busy: boolean; error: string | null; onStart: (mode: LearningMode, category?: string) => void }) {
  const [topic, setTopic] = useState(catalog.categories[0]?.slug ?? '');
  return <section>
    <Link className="eyebrow hover:text-white" to="/learn">CLIRace Learn / Linux Core</Link>
    <div className="learn-intro-grid">
      <div><h1 className="learn-hero-title">Linux Core.<br /><span>С объяснениями.</span></h1><p className="learn-lead">Ответьте один раз, разберите причину и двигайтесь дальше. Это обучающий режим: главное здесь — понять ответ, а не угадать.</p></div>
      <div className="learn-method"><span>ВОПРОС</span><i>→</i><span>ОТВЕТ</span><i>→</i><span>РАЗБОР</span><i>→</i><span>ПРАКТИКА</span></div>
    </div>
    {catalog.progress && catalog.progress.answered > 0 && <p className="learn-progress-note">Ваш прогресс: {catalog.progress.correct} верных из {catalog.progress.answered} ответов</p>}
    <div className="learn-mode-grid">
      {catalog.modes.filter((mode) => mode.id !== 'topic').map((mode) => <button key={mode.id} type="button" className="learn-mode" disabled={!mode.available || busy || auth === 'guest'} onClick={() => onStart(mode.id)}>
        <small>{mode.available ? 'Доступен' : 'Недостаточно вопросов'}</small><strong>{mode.title}</strong><span>{mode.questions} уникальных вопросов</span><ChevronRight size={18} />
      </button>)}
      <div className="learn-mode learn-topic"><small>По одной теме</small><strong>Практика по теме</strong><select aria-label="Тема практики" value={topic} onChange={(event) => setTopic(event.target.value)}>{catalog.categories.map((category) => <option key={category.slug} value={category.slug}>{categoryNames[category.slug] ?? category.slug} · {category.count}</option>)}</select><button type="button" disabled={!topic || busy || auth === 'guest'} onClick={() => onStart('topic', topic)}>Начать <ChevronRight size={15} /></button></div>
    </div>
    {auth === 'guest' && <div className="learn-auth"><strong>Чтобы сохранить обучение, нужен аккаунт.</strong><Link className="primary-button" to={`/?auth=1&returnTo=${encodeURIComponent('/learn/linux-core')}`}>Войти <ArrowRight size={15} /></Link></div>}
    {error && <p className="play-error mt-6" role="alert">{error}</p>}
  </section>;
}

function QuestionScreen({ session, busy, error, onRequest }: { session: LearnSession; busy: boolean; error: string | null; onRequest: (url: string, body?: unknown) => void }) {
  const question = session.question!;
  const progress = session.progress!;
  const feedback = session.feedback;
  const [selected, setSelected] = useState<string[]>(feedback?.selectedAnswerIds ?? []);
  useEffect(() => setSelected(feedback?.selectedAnswerIds ?? []), [question.slug, feedback?.selectedAnswerIds]);
  const multiple = question.type === 'multiple_choice';
  const answerMap = useMemo(() => new Map(question.answers.map((answer) => [answer.id, answer.text])), [question.answers]);
  const choose = (id: string) => {
    if (feedback) return;
    setSelected((current) => multiple ? current.includes(id) ? current.filter((value) => value !== id) : [...current, id] : [id]);
  };
  const submit = (event: FormEvent) => { event.preventDefault(); onRequest(`/api/learn/sessions/${session.id}/answers`, { questionSlug: question.slug, answerIds: selected }); };
  return <section className="learn-session">
    <div className="learn-session-top"><div><span>LINUX CORE</span><strong>{progress.current} / {progress.total}</strong></div><div className="learn-progress-track"><i style={{ width: `${((progress.current - (feedback ? 0 : 1)) / progress.total) * 100}%` }} /></div><span>{categoryNames[question.category] ?? question.category}</span></div>
    <div className="learn-question-card">
      <div className="learn-question-meta"><span>{learningQuestionType(question.type)}</span><span>{learningDifficulty(question.difficulty)}</span><span>{categoryNames[question.category] ?? question.category}</span></div>
      <h1>{question.text}</h1>
      {multiple && !feedback && <p className="learn-hint">Можно выбрать несколько вариантов.</p>}
      <form onSubmit={submit}>
        <div className="learn-answers">
          {question.answers.map((answer, index) => {
            const chosen = selected.includes(answer.id);
            const correct = feedback?.correctAnswerIds.includes(answer.id);
            const state = feedback ? correct ? 'correct' : chosen ? 'wrong' : 'muted' : chosen ? 'selected' : '';
            return <button type="button" key={answer.id} className={`learn-answer ${state}`} disabled={Boolean(feedback)} onClick={() => choose(answer.id)} aria-pressed={chosen}>
              <span>{String.fromCharCode(65 + index)}</span><p>{answer.text}</p>{feedback && correct ? <Check size={17} /> : feedback && chosen ? <X size={17} /> : null}
            </button>;
          })}
        </div>
        {!feedback && <div className="learn-submit-row"><span>Ответ фиксируется один раз</span><button className="primary-button" type="submit" disabled={selected.length === 0 || busy}>{busy ? <LoaderCircle className="animate-spin" size={16} /> : <Check size={16} />} Проверить</button></div>}
      </form>
      {feedback && <div className={`learn-feedback ${feedback.isCorrect ? 'is-correct' : 'is-wrong'}`}>
        <div className="learn-feedback-title">{feedback.isCorrect ? <CheckCircle2 size={21} /> : <CircleAlert size={21} />}<strong>{feedback.isCorrect ? 'Верно — закрепите вывод' : 'Разберём ответ'}</strong></div>
        <section><small>Почему это правильно</small><p>{feedback.explanation}</p></section>
        {!feedback.isCorrect && feedback.selectedAnswerExplanation && <section><small>Почему твой вариант неверен</small><p><strong>Вы выбрали: «{answerMap.get(feedback.selectedAnswerIds[0] ?? '') ?? 'вариант ответа'}»</strong><br />{feedback.selectedAnswerExplanation}</p></section>}
        <div className="learn-feedback-actions">
          {feedback.shellPracticeChallengeSlug && <Link className="secondary-button" to={`/play?mode=real_shell&challenge=${encodeURIComponent(feedback.shellPracticeChallengeSlug)}`}><Terminal size={15} /> Попробовать в терминале</Link>}
          <button className="primary-button" type="button" disabled={busy} onClick={() => onRequest(`/api/learn/sessions/${session.id}/next`)}>{progress.current === progress.total ? 'Показать результат' : 'Следующий вопрос'} <ChevronRight size={16} /></button>
        </div>
      </div>}
      {error && <p className="play-error mt-5" role="alert">{error}</p>}
    </div>
  </section>;
}

function ResultScreen({ session, busy, onStart }: { session: LearnSession; busy: boolean; onStart: (mode: LearningMode, category?: string) => void }) {
  const result = session.result!;
  return <section className="learn-results">
    <p className="eyebrow">Проверка завершена</p><h1>Результат Linux Core</h1><div className="learn-score"><strong>{result.percent}%</strong><span>{result.correct} / {result.total} верно</span></div>
    <div className="learn-breakdown"><h2>Разбор по темам</h2>{Object.entries(result.categories).map(([slug, stat]) => <div key={slug}><span>{categoryNames[slug] ?? slug}</span><div><i style={{ width: `${stat.accuracy}%` }} /></div><strong>{stat.accuracy}%</strong><small>{stat.answered < 2 ? 'мало данных' : `${stat.correct}/${stat.answered}`}</small></div>)}</div>
    <div className="learn-area-grid"><section><small>Сильные темы</small><p>{result.strongAreas.length ? result.strongAreas.map((slug) => categoryNames[slug] ?? slug).join(' · ') : 'Нужно больше ответов для уверенного вывода.'}</p></section><section><small>Слабые темы</small><p>{result.weakAreas.length ? result.weakAreas.map((slug) => categoryNames[slug] ?? slug).join(' · ') : 'Нет тем с достаточной выборкой ниже 60%.'}</p></section></div>
    <div className="mt-8 flex flex-wrap justify-center gap-3"><Link className="secondary-button" to="/learn">Все курсы</Link>{result.weakAreas[0] && <Link className="secondary-button" to={practiceHrefForWeakArea(result.weakAreas[0])}><Terminal size={15} /> Практиковать: {categoryNames[result.weakAreas[0]] ?? result.weakAreas[0]}</Link>}<button className="primary-button" type="button" disabled={busy} onClick={() => onStart('quick')}><RotateCcw size={15} /> Ещё 10 вопросов</button></div>
  </section>;
}

function Loading() { return <div className="flex min-h-[55vh] items-center justify-center gap-3 font-mono text-xs uppercase tracking-[0.14em] text-slate-500"><LoaderCircle className="animate-spin text-acid" size={18} /> Загружаем Linux Core</div>; }

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(payload.message ?? 'Ошибка API');
  return payload;
}
