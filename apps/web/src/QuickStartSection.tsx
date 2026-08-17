import { ArrowRight, Bolt, Boxes, GitBranch, Shuffle, Terminal, TimerReset } from 'lucide-react';
import { useEffect, useState } from 'react';

const presets = [
  {
    icon: Bolt,
    eyebrow: 'Начать с нуля',
    title: 'Первые 5 команд',
    description: 'pwd, ls, cat, mkdir и другие команды, с которых начинается уверенная работа в Linux.',
    tags: ['Linux', 'Легко', '5 заданий'],
    href: '/play?category=linux&difficulty=Easy&mode=mixed&count=5',
  },
  {
    icon: TimerReset,
    eyebrow: 'Быстрый темп',
    title: 'Скоростной круг',
    description: 'Десять коротких задач без длинной теории. Ответ обычно помещается в одну команду.',
    tags: ['Все темы', 'Быстро', '10 заданий'],
    href: '/play?category=all&difficulty=Easy&mode=quick&count=10',
  },
  {
    icon: Terminal,
    eyebrow: 'Настоящий терминал',
    title: 'Shell-разминка',
    description: 'Простые действия с настоящими файлами в безопасной Linux-песочнице и понятные подсказки.',
    tags: ['Shell', 'Легко', '5 заданий'],
    href: '/play?category=all&difficulty=Easy&mode=real_shell&count=5',
  },
  {
    icon: GitBranch,
    eyebrow: 'Без паники',
    title: 'Git для новичка',
    description: 'Статус, история, добавление файлов и базовые действия без сложных ветвлений.',
    tags: ['Git', 'Легко', '5 заданий'],
    href: '/play?category=git&difficulty=Easy&mode=mixed&count=5',
  },
  {
    icon: Boxes,
    eyebrow: 'Текстовые фокусы',
    title: 'Bash-конструктор',
    description: 'grep, head, tail, sort и другие маленькие инструменты на весёлых файлах-примерах.',
    tags: ['Bash', 'Легко', '10 заданий'],
    href: '/play?category=bash&difficulty=Easy&mode=quick&count=10',
  },
  {
    icon: Shuffle,
    eyebrow: 'Не выбирать',
    title: 'Случайный микс',
    description: 'Лёгкая подборка из разных категорий: просто нажмите старт и ловите ритм.',
    tags: ['Все темы', 'Легко', '10 заданий'],
    href: '/play?category=all&difficulty=Easy&mode=mixed&count=10',
  },
] as const;

export function QuickStartSection() {
  const [total, setTotal] = useState<number | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/categories', { signal: controller.signal })
      .then((response) => response.json() as Promise<{ categories?: Array<{ challenge_count: number }> }>)
      .then((payload) => setTotal((payload.categories ?? []).reduce((sum, category) => sum + category.challenge_count, 0)))
      .catch(() => setTotal(null));
    return () => controller.abort();
  }, []);

  return (
    <section id="quick-start" className="border-y border-line bg-[#0a0e13]/90">
      <div className="page-width py-20">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Быстрый старт</p>
            <h2>Выберите настроение. Остальное уже настроено.</h2>
          </div>
          <p>Мы собрали {total ? `${total} заданий` : 'большую библиотеку заданий'} в короткие понятные забеги. Начните с простого и повышайте сложность, когда станет легко.</p>
        </div>

        <div className="mt-10 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {presets.map(({ icon: Icon, eyebrow, title, description, tags, href }) => (
            <a className="quick-start-card group" href={href} key={title}>
              <div className="flex items-start justify-between gap-4">
                <span className="quick-start-icon"><Icon size={18} /></span>
                <ArrowRight className="text-slate-700 transition-transform group-hover:translate-x-1 group-hover:text-acid" size={16} />
              </div>
              <p className="mt-6 font-mono text-[9px] font-semibold uppercase tracking-[0.16em] text-cyan">{eyebrow}</p>
              <h3 className="mt-2 text-xl font-semibold text-white">{title}</h3>
              <p className="mt-3 text-sm leading-6 text-slate-500">{description}</p>
              <div className="mt-auto flex flex-wrap gap-2 pt-6">
                {tags.map((tag) => <span className="quick-start-tag" key={tag}>{tag}</span>)}
              </div>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}
