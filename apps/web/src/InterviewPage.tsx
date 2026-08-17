import { ArrowLeft, CheckCircle2, ChevronDown, LoaderCircle, Play, TerminalSquare } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

interface Task {
  slug: string; title: string; description: string; difficulty: 'Easy' | 'Medium' | 'Hard';
  type: 'quick' | 'real_shell'; topic: string; position: number; category_name: string;
  solved: boolean; solution: string | null; explanation: string | null; alternatives: string[];
}
interface Payload {
  summary: { total: number; solved: number; easy: number; medium: number; hard: number };
  topics: { slug: string; name: string }[];
  authenticated: boolean;
  tasks: Task[];
}

export function InterviewPage() {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('all');
  const [difficulty, setDifficulty] = useState('all');
  const [topic, setTopic] = useState('all');
  const [busy, setBusy] = useState<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/interview', { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as Payload & { message?: string };
        if (!response.ok) throw new Error(body.message ?? 'Коллекция временно недоступна.');
        setPayload(body);
      })
      .catch((reason) => { if (reason.name !== 'AbortError') setError(reason.message); });
    return () => controller.abort();
  }, []);

  const tasks = useMemo(() => payload?.tasks.filter((task) =>
    (status === 'all' || (status === 'solved') === task.solved)
    && (difficulty === 'all' || difficulty === task.difficulty)
    && (topic === 'all' || topic === task.topic)) ?? [], [payload, status, difficulty, topic]);

  const startRun = async (taskCount: 10 | 25 | 50) => {
    if (!payload?.authenticated) {
      window.location.href = `/?auth=1&returnTo=${encodeURIComponent('/interview')}`;
      return;
    }
    setBusy(taskCount); setError(null);
    try {
      const response = await fetch('/api/interview/runs', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskCount }),
      });
      const body = await response.json() as { session?: { id: string }; message?: string };
      if (!response.ok || !body.session) throw new Error(body.message ?? 'Не удалось начать Interview Run.');
      window.location.href = `/play?session=${encodeURIComponent(body.session.id)}`;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Не удалось начать Interview Run.');
      setBusy(null);
    }
  };

  if (!payload && !error) return <Page><div className="flex min-h-[60vh] items-center justify-center text-slate-500"><LoaderCircle className="animate-spin" /></div></Page>;
  if (!payload) return <Page><p className="play-error mt-16">{error}</p></Page>;
  const percent = Math.round((payload.summary.solved / payload.summary.total) * 100);

  return <Page>
    <a href="/" className="mb-8 inline-flex items-center gap-2 text-xs text-slate-500 hover:text-white"><ArrowLeft size={14} /> На главную</a>
    <section className="grid gap-10 lg:grid-cols-[1fr_0.75fr] lg:items-end">
      <div>
        <p className="eyebrow">Коллекция · Linux / DevOps</p>
        <h1 className="mt-4 text-5xl font-semibold tracking-[-0.055em] text-white sm:text-7xl">Interview <span className="text-acid">100</span></h1>
        <p className="mt-5 max-w-2xl text-base leading-7 text-slate-400">Сто практических задач для подготовки к техническому собеседованию. Команды, диагностика и настоящая shell-песочница.</p>
      </div>
      <div className="rounded-lg border border-line bg-panel p-6">
        <div className="flex items-end justify-between"><span className="font-mono text-xs uppercase tracking-[.14em] text-slate-500">Прогресс</span><strong className="text-3xl text-white">{payload.summary.solved}<span className="text-slate-600">/100</span></strong></div>
        <div className="mt-4 h-2 overflow-hidden rounded-full bg-black"><div className="h-full bg-acid transition-all" style={{ width: `${percent}%` }} /></div>
        <div className="mt-3 font-mono text-[10px] text-slate-500">{percent}% коллекции завершено</div>
      </div>
    </section>

    <section className="mt-10 grid gap-3 sm:grid-cols-3">
      {([10, 25, 50] as const).map((count) => <button key={count} type="button" disabled={busy !== null} onClick={() => void startRun(count)} className="group flex items-center justify-between rounded-md border border-line bg-[#0b1016] p-5 text-left transition hover:border-acid/50 disabled:opacity-50">
        <span><strong className="block text-xl text-white">{count} задач</strong><small className="mt-1 block font-mono text-[10px] uppercase tracking-[.12em] text-slate-500">Interview Run</small></span>
        {busy === count ? <LoaderCircle className="animate-spin text-acid" size={20} /> : <Play className="text-acid" size={20} />}
      </button>)}
    </section>
    {error && <p className="play-error mt-5">{error}</p>}

    <section className="mt-14">
      <div className="flex flex-col gap-3 border-y border-line py-5 lg:flex-row">
        <Filter value={status} onChange={setStatus} label="Статус" options={[['all','Все'],['unsolved','Не решены'],['solved','Решены']]} />
        <Filter value={difficulty} onChange={setDifficulty} label="Сложность" options={[['all','Любая'],['Easy','Easy · 30'],['Medium','Medium · 50'],['Hard','Hard · 20']]} />
        <Filter value={topic} onChange={setTopic} label="Тема" options={[['all','Все темы'], ...payload.topics.map((item) => [item.slug, item.name])]} />
        <span className="ml-auto self-center font-mono text-[10px] uppercase tracking-[.14em] text-slate-500">Показано: {tasks.length}</span>
      </div>
      <div className="mt-6 grid gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-2 lg:grid-cols-3">
        {tasks.map((task) => <TaskCard key={task.slug} task={task} topicName={payload.topics.find((item) => item.slug === task.topic)?.name ?? task.topic} />)}
      </div>
      {tasks.length === 0 && <div className="py-16 text-center text-sm text-slate-500">По этим фильтрам задач нет.</div>}
    </section>
  </Page>;
}

function TaskCard({ task, topicName }: { task: Task; topicName: string }) {
  return <details className="group min-h-64 bg-panel p-6 open:bg-[#101720]">
    <summary className="flex h-full cursor-pointer list-none flex-col">
      <div className="flex items-center justify-between"><span className="font-mono text-[10px] uppercase tracking-[.13em] text-cyan">{String(task.position).padStart(3, '0')} · {topicName}</span><span className="difficulty">{task.difficulty}</span></div>
      <h2 className="mt-5 text-lg font-semibold text-white">{task.title}</h2>
      <p className="mt-3 text-sm leading-6 text-slate-400">{task.description}</p>
      <div className="mt-auto flex items-center justify-between border-t border-line pt-5 font-mono text-[10px] uppercase tracking-[.12em] text-slate-600">
        <span className="flex items-center gap-2">{task.type === 'real_shell' ? <TerminalSquare size={13} /> : <ChevronDown size={13} />} {task.type === 'real_shell' ? 'Shell' : 'Команда'}</span>
        {task.solved ? <span className="flex items-center gap-1 text-acid"><CheckCircle2 size={13} /> Решено</span> : <span>Не решено</span>}
      </div>
    </summary>
    <div className="mt-5 border-t border-line pt-5">
      {task.solved ? <>
        <p className="font-mono text-[10px] uppercase tracking-[.12em] text-slate-500">Решение</p>
        <code className="mt-2 block overflow-x-auto rounded bg-black p-3 text-xs text-acid">{task.solution}</code>
        <p className="mt-4 text-sm leading-6 text-slate-400">{task.explanation}</p>
        {task.alternatives.length > 0 && <p className="mt-3 text-xs text-slate-500">Альтернатива: <code>{task.alternatives.join(' · ')}</code></p>}
      </> : <p className="text-xs leading-5 text-slate-500">Решение и объяснение откроются после успешного выполнения в Interview Run.</p>}
    </div>
  </details>;
}

function Filter({ value, onChange, label, options }: { value: string; onChange: (value: string) => void; label: string; options: string[][] }) {
  return <label className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[.12em] text-slate-500"><span>{label}</span><select className="rounded border border-line bg-panel px-3 py-2 text-xs normal-case tracking-normal text-slate-200" value={value} onChange={(event) => onChange(event.target.value)}>{options.map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>;
}

function Page({ children }: { children: ReactNode }) {
  return <div className="min-h-screen bg-ink text-slate-200"><div className="grid-noise fixed inset-0 pointer-events-none" /><header className="relative z-10 border-b border-line"><div className="page-width flex h-16 items-center justify-between"><a href="/" className="flex items-center gap-2.5"><span className="logo-mark"><span>&gt;_</span></span><span className="font-mono text-sm font-bold tracking-[.12em] text-white">CLIRACE</span></a><nav className="flex gap-5 font-mono text-[10px] uppercase tracking-[.12em] text-slate-500"><a href="/play" className="hover:text-white">Играть</a><a href="/daily" className="hover:text-white">Daily</a><a href="/battle" className="hover:text-white">Battle</a></nav></div></header><main className="page-width relative z-10 py-10 sm:py-16">{children}</main></div>;
}
