import { ArrowLeft, ArrowRight, BookOpen, Check, CheckCircle2, ChevronRight, Circle, CircleAlert, Clock3, Code2, FileQuestion, FlaskConical, Gauge, LoaderCircle, LockKeyhole, Map as MapIcon, RotateCcw, Terminal, Trophy, X } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from 'react';
import { CommunityHeader } from './CommunityHeader';
import { currentUser } from './auth-client';
import { humanizeError } from './errors';
import { learningDifficulty, learningQuestionType } from './product-ux';
import { difficultyLabel } from './product-language';
import { Link, useLocation, useNavigate } from 'react-router-dom';

type Enrollment = { status: 'active' | 'completed'; progress: number; finalScore: number | null; startedAt: string; completedAt: string | null };
type PathItem = { stableId: string; slug: string; title: string; type: ItemType; status: ItemStatus; score: number | null };
type PathModule = {
  slug: string; title: string; description: string; order: number; estimatedMinutes: number; prerequisites: string[];
  status?: 'completed' | 'current' | 'available' | 'locked'; completedItems?: number; totalItems?: number;
  itemCount?: number; items?: PathItem[]; result?: ModuleResult | null;
};
type CourseState = {
  course: { slug: string; title: string; description: string; version: number; estimatedMinutes: number; level: string };
  enrollment: Enrollment | null; modules: PathModule[]; resume?: { module: string; item: string; title: string } | null;
};
type ItemType = 'theory' | 'knowledge_check' | 'practice' | 'shell_lab' | 'checkpoint';
type ItemStatus = 'completed' | 'failed' | 'current' | 'available' | 'locked';
type ModuleResult = { knowledge: number; practice: number; lab: number; checkpoint: number; mastery: number; recommendations: string[] };
type TheoryBlock = { type: 'heading' | 'paragraph' | 'bullets' | 'code' | 'note'; text?: string; items?: string[]; code?: string; tone?: 'note' | 'warning' };
type ItemDetail = {
  course: CourseState['course']; module: PathModule;
  item: { stableId: string; slug: string; title: string; type: ItemType; category: string; concept: string; version: number;
    status: ItemStatus; score: number | null; recommendations?: string[]; theory?: TheoryBlock[]; questionCount?: number; passThreshold?: number;
    challenges?: { slug: string; title: string; description: string; difficulty: string; type: string; completed: boolean }[] };
  resume: CourseState['resume'];
};
type LearnSession = {
  id: string; status: 'active' | 'completed'; progress?: { current: number; total: number; answered: boolean };
  question?: { slug: string; category: string; concept: string; difficulty: 'easy' | 'medium' | 'hard'; type: 'single_choice' | 'multiple_choice' | 'scenario' | 'command_output'; text: string; answers: { id: string; text: string }[] };
  feedback?: { isCorrect: boolean; selectedAnswerIds: string[]; correctAnswerIds: string[]; explanation: string; selectedAnswerExplanation: string | null };
  result?: { correct: number; total: number; percent: number };
};
type CatalogCourse = CourseState['course'] & { enrollment: Enrollment | null };

const itemLabels: Record<ItemType, string> = { theory: 'Теория', knowledge_check: 'Проверка знаний', practice: 'Практика', shell_lab: 'Shell Lab', checkpoint: 'Checkpoint' };
const categoryNames: Record<string, string> = { filesystem: 'Файловая система', permissions: 'Права доступа', processes: 'Процессы', users_groups: 'Пользователи и группы', networking: 'Сети', storage: 'Хранилище', systemd: 'systemd', logs: 'Логи', bash: 'Bash', troubleshooting: 'Диагностика' };

export function LearningPathsPage() {
  const { pathname } = useLocation();
  const segments = pathname.split('/').filter(Boolean);
  const courseSlug = segments[2];
  const moduleSlug = segments[3];
  const itemSlug = segments[4];
  if (!courseSlug) return <PathsCatalog />;
  if (moduleSlug && itemSlug) return <PathItemPage courseSlug={courseSlug} moduleSlug={moduleSlug} itemSlug={itemSlug} />;
  return <CoursePage courseSlug={courseSlug} {...(moduleSlug ? { moduleSlug } : {})} />;
}

function PathsCatalog() {
  const [courses, setCourses] = useState<CatalogCourse[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { const controller = new AbortController(); fetch('/api/learn/paths', { signal: controller.signal }).then(readJson<{ courses: CatalogCourse[] }>).then((payload) => setCourses(payload.courses)).catch((reason) => { if (reason.name !== 'AbortError') setError(humanizeError(reason, 'Не удалось загрузить учебные пути.')); }); return () => controller.abort(); }, []);
  return <Page><section className="path-hero"><p className="eyebrow">Learning Paths</p><h1>Linux — последовательно.<br /><span>От идеи до настоящего shell.</span></h1><p>Короткая теория сразу переходит в вопросы, команды, лабораторные и checkpoint. Прогресс хранится на сервере.</p></section>
    {error && <p className="play-error mt-6" role="alert">{error}</p>}
    {!courses ? <Loading label="Загружаем учебные пути" /> : <div className="path-catalog-grid">{courses.map((course) => <Link className="path-course-card" to={`/learn/paths/${course.slug}`} key={course.slug}><span className="mode-card-icon"><MapIcon size={19} /></span><small>{course.enrollment?.status === 'completed' ? 'Курс завершён' : course.enrollment ? `${course.enrollment.progress}% пройдено` : 'Для начинающих'}</small><h2>{course.title}</h2><p>{course.description}</p><div><span><Clock3 size={13} /> ≈ {formatMinutes(course.estimatedMinutes)}</span><strong>{course.enrollment ? 'Продолжить' : 'Открыть путь'} <ArrowRight size={15} /></strong></div></Link>)}</div>}
  </Page>;
}

function CoursePage({ courseSlug, moduleSlug }: { courseSlug: string; moduleSlug?: string }) {
  const [state, setState] = useState<CourseState | null>(null);
  const [auth, setAuth] = useState<'loading' | 'guest' | 'ready'>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = () => Promise.all([currentUser(), fetch(`/api/learn/paths/${encodeURIComponent(courseSlug)}`).then(readJson<CourseState>)]).then(([user, payload]) => { setAuth(user.user ? 'ready' : 'guest'); setState(payload); });
  useEffect(() => { load().catch((reason) => setError(humanizeError(reason, 'Не удалось загрузить курс.'))).finally(() => setAuth((value) => value === 'loading' ? 'guest' : value)); }, [courseSlug]);
  const enroll = async () => { setBusy(true); setError(null); try { const response = await fetch(`/api/learn/paths/${courseSlug}/enroll`, { method: 'POST' }); setState(await readJson<CourseState>(response)); setAuth('ready'); } catch (reason) { setError(humanizeError(reason, 'Не удалось начать курс.')); } finally { setBusy(false); } };
  if (!state) return <Page>{error ? <p className="play-error" role="alert">{error}</p> : <Loading label="Загружаем Linux Foundations" />}</Page>;
  const selectedModule = moduleSlug ? state.modules.find((module) => module.slug === moduleSlug) : null;
  if (moduleSlug && !selectedModule) return <Page><p className="play-error">Модуль не найден.</p></Page>;
  return <Page>
    {selectedModule ? <ModuleView course={state} module={selectedModule} auth={auth} /> : <CourseMap state={state} auth={auth} busy={busy} onEnroll={enroll} />}
    {error && <p className="play-error mt-6" role="alert">{error}</p>}
  </Page>;
}

function CourseMap({ state, auth, busy, onEnroll }: { state: CourseState; auth: string; busy: boolean; onEnroll: () => void }) {
  return <>
    <Link className="eyebrow hover:text-white" to="/learn/paths">Learning Paths</Link>
    <section className="path-course-head"><div><h1>{state.course.title}</h1><p>{state.course.description}</p></div><div className="path-overall"><strong>{state.enrollment?.progress ?? 0}%</strong><span>{state.enrollment?.status === 'completed' ? `Завершено · ${state.enrollment.finalScore}%` : 'общий прогресс'}</span></div></section>
    {!state.enrollment && <div className="path-start-panel"><div><strong>Готовы начать?</strong><p>Модули открываются последовательно. Курс не блокирует обычную практику и Linux Core.</p></div>{auth === 'guest' ? <Link className="primary-button" to={`/?auth=1&returnTo=${encodeURIComponent(`/learn/paths/${state.course.slug}`)}`}>Войти и начать <ArrowRight size={15} /></Link> : <button className="primary-button" disabled={busy} onClick={onEnroll}>{busy ? <LoaderCircle className="animate-spin" size={15} /> : <MapIcon size={15} />} Начать курс</button>}</div>}
    {state.resume && <Link className="path-resume" to={itemHref(state.course.slug, state.resume.module, state.resume.item)}><div><small>Продолжить курс</small><strong>{state.resume.title}</strong></div><span>{state.enrollment?.progress}%</span><ArrowRight size={17} /></Link>}
    {state.enrollment?.status === 'completed' && <CourseResult state={state} />}
    <section className="path-map" aria-label="Карта курса">{state.modules.map((module, index) => <ModuleNode key={module.slug} courseSlug={state.course.slug} module={module} index={index} enrolled={Boolean(state.enrollment)} />)}</section>
  </>;
}

function ModuleNode({ courseSlug, module, index, enrolled }: { courseSlug: string; module: PathModule; index: number; enrolled: boolean }) {
  const status = module.status ?? (index === 0 ? 'available' : 'locked');
  const content = <><span className="path-node-index">{String(index + 1).padStart(2, '0')}</span><span className={`path-node-state ${status}`}>{statusIcon(status)} {statusLabel(status)}</span><h2>{module.title}</h2><p>{module.description}</p><footer><span>{module.completedItems ?? 0} / {module.totalItems ?? module.itemCount ?? 0} шагов</span><span>{formatMinutes(module.estimatedMinutes)}</span></footer></>;
  return enrolled && status !== 'locked' ? <Link className={`path-module-node ${status}`} to={`/learn/paths/${courseSlug}/${module.slug}`}>{content}</Link> : <article className={`path-module-node ${status}`} aria-disabled={status === 'locked'}>{content}</article>;
}

function ModuleView({ course, module, auth }: { course: CourseState; module: PathModule; auth: string }) {
  if (!course.enrollment || auth !== 'ready') return <section className="state-panel"><LockKeyhole size={24} className="text-acid" /><div><h1>Сначала начните курс</h1><p>Enrollment нужен, чтобы сервер проверял prerequisites и сохранял каждый шаг.</p></div><Link className="primary-button" to={`/learn/paths/${course.course.slug}`}>К карте курса <ArrowRight size={14} /></Link></section>;
  if (module.status === 'locked') return <section className="state-panel"><LockKeyhole size={24} /><div><h1>Модуль пока закрыт</h1><p>Завершите предыдущий модуль — проверка выполняется сервером.</p></div><Link className="secondary-button" to={`/learn/paths/${course.course.slug}`}>К карте курса</Link></section>;
  return <>
    <Link className="eyebrow hover:text-white" to={`/learn/paths/${course.course.slug}`}>Linux Foundations / Модуль {module.order}</Link>
    <section className="path-module-head"><div><h1>{module.title}</h1><p>{module.description}</p></div><div><strong>{module.completedItems} / {module.totalItems}</strong><span>шагов завершено</span></div></section>
    {module.result && <ModuleResultCard result={module.result} />}
    <div className="path-items">{module.items?.map((item, index) => { const disabled = item.status === 'locked' || item.status === 'available'; return disabled ? <article className={`path-item-row ${item.status}`} key={item.stableId}>{itemStatusIcon(item.status)}<div><small>{itemLabels[item.type]}</small><strong>{item.title}</strong></div><span>{itemStatusLabel(item.status)}</span></article> : <Link className={`path-item-row ${item.status}`} key={item.stableId} to={itemHref(course.course.slug, module.slug, item.slug)}>{itemStatusIcon(item.status)}<div><small>{itemLabels[item.type]}</small><strong>{item.title}</strong></div><span>{item.status === 'completed' && item.score !== null ? `${item.score}%` : itemStatusLabel(item.status)}</span><ChevronRight size={16} /></Link>; })}</div>
  </>;
}

function PathItemPage({ courseSlug, moduleSlug, itemSlug }: { courseSlug: string; moduleSlug: string; itemSlug: string }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [session, setSession] = useState<LearnSession | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endpoint = `/api/learn/paths/${courseSlug}/modules/${moduleSlug}/items/${itemSlug}`;
  const load = () => fetch(endpoint).then(readJson<ItemDetail>).then(setDetail);
  useEffect(() => { currentUser().then(({ user }) => { if (!user) { navigate(`/?auth=1&returnTo=${encodeURIComponent(pathname)}`, { replace: true }); return; } return load(); }).catch((reason) => setError(humanizeError(reason, 'Не удалось открыть учебный шаг.'))); }, [endpoint, navigate, pathname]);
  const completeTheory = () => action(`/api/learn/paths/${courseSlug}/items/${detail!.item.stableId}/complete-theory`, async () => { await load(); navigate(`/learn/paths/${detail!.course.slug}/${detail!.module.slug}`); });
  const startAssessment = () => action(`/api/learn/paths/${courseSlug}/items/${detail!.item.stableId}/start-assessment`, async (payload) => setSession(payload as LearnSession));
  const sync = () => action(`/api/learn/paths/${courseSlug}/sync`, async () => { await load(); });
  const action = async (url: string, done: (payload: unknown) => Promise<void>) => { setBusy(true); setError(null); try { const response = await fetch(url, { method: 'POST' }); const payload = await readJson<unknown>(response); await done(payload); } catch (reason) { setError(humanizeError(reason, 'Не удалось сохранить прогресс.')); } finally { setBusy(false); } };
  const assessmentRequest = async (url: string, body?: unknown) => { setBusy(true); setError(null); try { const response = await fetch(url, { method: 'POST', ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) }); const payload = await readJson<LearnSession>(response); setSession(payload); if (payload.status === 'completed') { await fetch(`/api/learn/paths/${courseSlug}/sync`, { method: 'POST' }); await load(); } } catch (reason) { setError(humanizeError(reason, 'Не удалось продолжить проверку.')); } finally { setBusy(false); } };
  if (!detail) return <Page>{error ? <p className="play-error" role="alert">{error}</p> : <Loading label="Загружаем учебный шаг" />}</Page>;
  return <Page>
    <Link className="eyebrow hover:text-white" to={`/learn/paths/${courseSlug}/${moduleSlug}`}><ArrowLeft size={12} /> {detail.module.title}</Link>
    {session?.status === 'active' && session.question && session.progress ? <PathQuestion session={session} busy={busy} error={error} onRequest={assessmentRequest} />
      : session?.status === 'completed' && session.result ? <AssessmentResult session={session} detail={detail} busy={busy} onRetry={startAssessment} onSync={sync} />
        : <ItemContent detail={detail} busy={busy} onTheory={completeTheory} onAssessment={startAssessment} onSync={sync} />}
    {error && <p className="play-error mt-6" role="alert">{error}</p>}
  </Page>;
}

function ItemContent({ detail, busy, onTheory, onAssessment, onSync }: { detail: ItemDetail; busy: boolean; onTheory: () => void; onAssessment: () => void; onSync: () => void }) {
  const item = detail.item;
  return <section className="path-item-detail"><header><span className="mode-card-icon">{typeIcon(item.type)}</span><div><small>{itemLabels[item.type]} · {categoryNames[item.category] ?? item.category}</small><h1>{item.title}</h1></div><span className={`path-node-state ${item.status}`}>{itemStatusLabel(item.status)}</span></header>
    {item.type === 'theory' && <TheoryContent blocks={item.theory ?? []} />}
    {(item.type === 'knowledge_check' || item.type === 'checkpoint') && <div className="path-assessment-intro"><FileQuestion size={24} /><div><h2>{item.questionCount} вопросов</h2><p>Проходной результат — {item.passThreshold}%. Ответы и объяснения обрабатывает существующий Linux Core engine.</p></div></div>}
    {item.status === 'failed' && item.recommendations && <aside className="path-review"><CircleAlert size={18} /><div><strong>Что повторить перед новой попыткой</strong>{item.recommendations.map((recommendation) => <p key={recommendation}>{recommendation}</p>)}</div></aside>}
    {(item.type === 'practice' || item.type === 'shell_lab') && <div className="path-challenges">{item.challenges?.map((challenge) => <article key={challenge.slug}><span>{challenge.completed ? <CheckCircle2 size={18} /> : <Terminal size={18} />}</span><div><small>{challenge.completed ? 'Уже выполнено' : difficultyLabel(challenge.difficulty)}</small><h2>{challenge.title}</h2><p>{challenge.description}</p></div>{!challenge.completed && <Link className="primary-button" to={`/play?mode=real_shell&challenge=${challenge.slug}&returnTo=${encodeURIComponent(window.location.pathname)}`}>Открыть терминал <ArrowRight size={14} /></Link>}</article>)}</div>}
    <footer className="path-item-actions">
      <Link className="secondary-button" to={`/learn/paths/${detail.course.slug}/${detail.module.slug}`}><ArrowLeft size={14} /> К модулю</Link>
      {item.status === 'completed' ? <Link className="primary-button" to={`/learn/paths/${detail.course.slug}/${detail.module.slug}`}>Следующий шаг <ArrowRight size={14} /></Link>
        : item.type === 'theory' ? <button className="primary-button" disabled={busy} onClick={onTheory}>Теория прочитана <Check size={14} /></button>
          : item.type === 'knowledge_check' || item.type === 'checkpoint' ? <button className="primary-button" disabled={busy} onClick={onAssessment}>{item.status === 'failed' ? <RotateCcw size={14} /> : <FileQuestion size={14} />}{item.status === 'failed' ? 'Повторить проверку' : 'Начать проверку'}</button>
            : <button className="primary-button" disabled={busy} onClick={onSync}><RotateCcw size={14} /> Проверить выполнение</button>}
    </footer>
  </section>;
}

function TheoryContent({ blocks }: { blocks: TheoryBlock[] }) { return <article className="path-theory">{blocks.map((block, index) => block.type === 'heading' ? <h2 key={index}>{block.text}</h2> : block.type === 'paragraph' ? <p key={index}>{block.text}</p> : block.type === 'bullets' ? <ul key={index}>{block.items?.map((item) => <li key={item}>{item}</li>)}</ul> : block.type === 'code' ? <pre key={index}><code>{block.code}</code></pre> : <aside key={index} className={block.tone === 'warning' ? 'warning' : ''}>{block.tone === 'warning' ? <CircleAlert size={17} /> : <BookOpen size={17} />}<p>{block.text}</p></aside>)}</article>; }

function PathQuestion({ session, busy, error, onRequest }: { session: LearnSession; busy: boolean; error: string | null; onRequest: (url: string, body?: unknown) => void }) {
  const question = session.question!; const progress = session.progress!; const feedback = session.feedback;
  const [selected, setSelected] = useState<string[]>(feedback?.selectedAnswerIds ?? []);
  useEffect(() => setSelected(feedback?.selectedAnswerIds ?? []), [question.slug, feedback?.selectedAnswerIds]);
  const multiple = question.type === 'multiple_choice';
  const answerMap = useMemo(() => new Map(question.answers.map((answer) => [answer.id, answer.text])), [question.answers]);
  const choose = (id: string) => { if (!feedback) setSelected((current) => multiple ? current.includes(id) ? current.filter((value) => value !== id) : [...current, id] : [id]); };
  const submit = (event: FormEvent) => { event.preventDefault(); onRequest(`/api/learn/sessions/${session.id}/answers`, { questionSlug: question.slug, answerIds: selected }); };
  return <section className="learn-session"><div className="learn-session-top"><div><span>LEARNING PATH</span><strong>{progress.current} / {progress.total}</strong></div><div className="learn-progress-track"><i style={{ width: `${((progress.current - (feedback ? 0 : 1)) / progress.total) * 100}%` }} /></div><span>{categoryNames[question.category] ?? question.category}</span></div><div className="learn-question-card"><div className="learn-question-meta"><span>{learningQuestionType(question.type)}</span><span>{learningDifficulty(question.difficulty)}</span></div><h1>{question.text}</h1>{multiple && !feedback && <p className="learn-hint">Можно выбрать несколько вариантов.</p>}<form onSubmit={submit}><div className="learn-answers">{question.answers.map((answer, index) => { const chosen = selected.includes(answer.id); const correct = feedback?.correctAnswerIds.includes(answer.id); const state = feedback ? correct ? 'correct' : chosen ? 'wrong' : 'muted' : chosen ? 'selected' : ''; return <button type="button" key={answer.id} className={`learn-answer ${state}`} disabled={Boolean(feedback)} onClick={() => choose(answer.id)} aria-pressed={chosen}><span>{String.fromCharCode(65 + index)}</span><p>{answer.text}</p>{feedback && correct ? <Check size={17} /> : feedback && chosen ? <X size={17} /> : null}</button>; })}</div>{!feedback && <div className="learn-submit-row"><span>Ответ сохраняется в Linux Core</span><button className="primary-button" type="submit" disabled={!selected.length || busy}>Проверить <Check size={15} /></button></div>}</form>{feedback && <div className={`learn-feedback ${feedback.isCorrect ? 'is-correct' : 'is-wrong'}`}><div className="learn-feedback-title">{feedback.isCorrect ? <CheckCircle2 size={21} /> : <CircleAlert size={21} />}<strong>{feedback.isCorrect ? 'Верно' : 'Разберём ответ'}</strong></div><section><small>Объяснение</small><p>{feedback.explanation}</p></section>{!feedback.isCorrect && feedback.selectedAnswerExplanation && <section><small>Почему выбранный вариант не подходит</small><p><strong>«{answerMap.get(feedback.selectedAnswerIds[0] ?? '') ?? 'Выбранный ответ'}»</strong><br />{feedback.selectedAnswerExplanation}</p></section>}<div className="learn-feedback-actions"><button className="primary-button" type="button" disabled={busy} onClick={() => onRequest(`/api/learn/sessions/${session.id}/next`)}>{progress.current === progress.total ? 'Завершить проверку' : 'Следующий вопрос'} <ChevronRight size={15} /></button></div></div>}{error && <p className="play-error mt-5">{error}</p>}</div></section>;
}

function AssessmentResult({ session, detail, busy, onRetry, onSync }: { session: LearnSession; detail: ItemDetail; busy: boolean; onRetry: () => void; onSync: () => void }) { const result = session.result!; const passed = result.percent >= (detail.item.passThreshold ?? 70); const successLabel = detail.item.type === 'checkpoint' ? 'Checkpoint пройден' : 'Проверка знаний пройдена'; return <section className="path-assessment-result"><span>{passed ? <Trophy size={30} /> : <CircleAlert size={30} />}</span><p className="eyebrow">{passed ? successLabel : 'Нужно повторить'}</p><h1>{result.percent}%</h1><p>{result.correct} из {result.total} ответов · проходной результат {detail.item.passThreshold}%</p><div className="mt-7 flex justify-center gap-3">{!passed && <button className="secondary-button" onClick={onRetry}><RotateCcw size={14} /> Повторить</button>}<button className="primary-button" disabled={busy} onClick={onSync}>Обновить прогресс <ArrowRight size={14} /></button></div></section>; }

function CourseResult({ state }: { state: CourseState }) { return <section className="path-course-result"><Trophy size={25} /><div><small>Курс завершён</small><h2>{state.course.title}</h2><p>Итоговый результат сохранён в профиле.</p></div><strong>{state.enrollment?.finalScore}%</strong><Link className="secondary-button" to="/profile">Открыть профиль <ArrowRight size={14} /></Link></section>; }
function ModuleResultCard({ result }: { result: ModuleResult }) { return <section className="path-module-result"><div><small>Модуль завершён</small><strong>Mastery {result.mastery}%</strong></div><span>Знания {result.knowledge}%</span><span>Практика {result.practice}%</span><span>Lab {result.lab}%</span><span>Checkpoint {result.checkpoint}%</span>{result.recommendations.length > 0 && <p>{result.recommendations.join(' ')}</p>}</section>; }
function Page({ children }: { children: ReactNode }) { return <div className="learning-path-page min-h-screen bg-ink text-slate-200"><div className="grid-noise fixed inset-0 pointer-events-none" /><CommunityHeader /><main className="page-width relative z-10 py-10 sm:py-16">{children}</main></div>; }
function Loading({ label }: { label: string }) { return <div className="flex min-h-[50vh] items-center justify-center gap-3 font-mono text-xs uppercase tracking-[0.14em] text-slate-500"><LoaderCircle className="animate-spin text-acid" size={18} /> {label}</div>; }
function itemHref(course: string, module: string, item: string) { return `/learn/paths/${course}/${module}/${item}`; }
function formatMinutes(value: number) { return value >= 60 ? `${Math.round(value / 60)} ч` : `${value} мин`; }
function statusLabel(status: string) { return ({ completed: 'завершён', current: 'текущий', available: 'доступен', locked: 'закрыт' } as Record<string, string>)[status] ?? status; }
function statusIcon(status: string) { return status === 'completed' ? <CheckCircle2 size={13} /> : status === 'locked' ? <LockKeyhole size={13} /> : status === 'current' ? <Gauge size={13} /> : <Circle size={13} />; }
function itemStatusLabel(status: string) { return ({ completed: 'Готово', failed: 'Повторить', current: 'Продолжить', available: 'Ожидает', locked: 'Закрыто' } as Record<string, string>)[status] ?? status; }
function itemStatusIcon(status: string) { return status === 'completed' ? <CheckCircle2 className="text-acid" size={19} /> : status === 'locked' ? <LockKeyhole size={18} /> : status === 'failed' ? <CircleAlert className="text-amber-300" size={19} /> : <Circle size={18} />; }
function typeIcon(type: ItemType) { return type === 'theory' ? <BookOpen size={19} /> : type === 'knowledge_check' || type === 'checkpoint' ? <FileQuestion size={19} /> : type === 'shell_lab' ? <FlaskConical size={19} /> : <Code2 size={19} />; }
async function readJson<T>(response: Response): Promise<T> { const payload = await response.json() as T & { message?: string }; if (!response.ok) throw new Error(payload.message ?? 'Ошибка API'); return payload; }
