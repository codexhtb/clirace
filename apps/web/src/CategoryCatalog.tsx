import { ArrowUpRight, Boxes, LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';

interface Category {
  slug: string;
  name: string;
  description: string;
  challenge_count: number;
}

interface Challenge {
  slug: string;
  title: string;
  description: string;
  difficulty: 'Easy' | 'Medium' | 'Hard' | 'Expert';
  type: 'typing' | 'recall' | 'quick' | 'real_shell';
  category_slug: string;
  category_name: string;
}

const typeLabels: Record<Challenge['type'], string> = {
  typing: 'Набор',
  recall: 'Вспомни',
  quick: 'Быстро',
  real_shell: 'Shell',
};

export function CategoryCatalog() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [selected, setSelected] = useState<string>('all');
  const [challenges, setChallenges] = useState<Challenge[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/categories')
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('categories unavailable')))
      .then((payload: { categories: Category[] }) => setCategories(payload.categories))
      .catch(() => setCategories([]));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    const query = selected === 'all' ? '?limit=6' : `?category=${encodeURIComponent(selected)}&limit=6`;
    fetch(`/api/challenges${query}`, { signal: controller.signal })
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('challenges unavailable')))
      .then((payload: { challenges: Challenge[] }) => setChallenges(payload.challenges))
      .catch(() => setChallenges([]))
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [selected]);

  return (
    <section id="categories" className="border-y border-line bg-[#0a0e13]/90">
      <div className="page-width py-20">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Каталог PHASE 2</p>
            <h2>Шесть направлений. Двадцать девять задач.</h2>
          </div>
          <p>Категории и задания уже загружаются из PostgreSQL через публичный API, готовый для игрового режима.</p>
        </div>

        <div className="mt-8 flex flex-wrap gap-2" aria-label="Фильтр категорий">
          <button type="button" className={`catalog-filter ${selected === 'all' ? 'catalog-filter-active' : ''}`} onClick={() => setSelected('all')}>
            Все <span>29</span>
          </button>
          {categories.map((category) => (
            <button type="button" key={category.slug} className={`catalog-filter ${selected === category.slug ? 'catalog-filter-active' : ''}`} onClick={() => setSelected(category.slug)}>
              {category.name} <span>{category.challenge_count}</span>
            </button>
          ))}
        </div>

        <div className="mt-8 grid gap-px overflow-hidden rounded-lg border border-line bg-line md:grid-cols-2 lg:grid-cols-3">
          {loading ? (
            <div className="col-span-full flex min-h-48 items-center justify-center bg-panel text-slate-500">
              <LoaderCircle size={20} className="animate-spin" />
            </div>
          ) : challenges.map((challenge) => (
            <article className="catalog-card" key={challenge.slug}>
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-cyan">{challenge.category_name}</span>
                <span className="difficulty">{challenge.difficulty}</span>
              </div>
              <h3 className="mt-5 text-base font-semibold text-white">{challenge.title}</h3>
              <p className="mt-2 line-clamp-2 text-sm leading-6 text-slate-500">{challenge.description}</p>
              <div className="mt-auto flex items-center justify-between border-t border-line pt-4 font-mono text-[10px] uppercase tracking-[0.12em] text-slate-600">
                <span className="flex items-center gap-1.5"><Boxes size={12} /> {typeLabels[challenge.type]}</span>
                <ArrowUpRight size={13} />
              </div>
            </article>
          ))}
          {!loading && challenges.length === 0 && (
            <div className="col-span-full bg-panel p-10 text-center text-sm text-slate-500">Каталог временно недоступен.</div>
          )}
        </div>
      </div>
    </section>
  );
}
