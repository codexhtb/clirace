import { ArrowRight, Bolt, Shuffle, Terminal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

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
    icon: Terminal,
    eyebrow: 'Настоящий терминал',
    title: 'Shell-разминка',
    description: 'Простые действия с настоящими файлами в безопасной Linux-песочнице и понятные подсказки.',
    tags: ['Shell', 'Легко', '5 заданий'],
    href: '/play?category=all&difficulty=Easy&mode=real_shell&count=5',
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
            <h2>Три простых способа начать.</h2>
          </div>
          <p>{total ? `${total} заданий` : 'Большая библиотека заданий'} уже разложены по темам и сложности. Для первого раза достаточно выбрать один вариант.</p>
        </div>

        <div className="mt-10 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {presets.map(({ icon: Icon, eyebrow, title, description, tags, href }) => (
            <Link className="quick-start-card group" to={href} key={title}>
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
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}
