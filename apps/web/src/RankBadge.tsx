interface RankBadgeProps {
  division?: string | null | undefined;
  mmr?: number | null | undefined;
  provisional?: boolean | undefined;
  placementGamesCompleted?: number | undefined;
  placementGamesRequired?: number | undefined;
  compact?: boolean;
}

export function RankBadge({ division, mmr, provisional = false, placementGamesCompleted = 0, placementGamesRequired = 5, compact = false }: RankBadgeProps) {
  const normalized = provisional ? 'unranked' : (division ?? 'unranked').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const title = provisional ? 'Квалификация' : division || 'Без ранга';
  const detail = provisional
    ? `${placementGamesCompleted}/${placementGamesRequired}`
    : typeof mmr === 'number' ? `${mmr} MMR` : null;
  return (
    <span className={`rank-badge rank-badge-${normalized} ${compact ? 'rank-badge-compact' : ''}`} title={detail ?? title}>
      <span className="rank-badge-mark" aria-hidden="true" />
      <span><strong>{title}</strong>{detail && <small>{detail}</small>}</span>
    </span>
  );
}
