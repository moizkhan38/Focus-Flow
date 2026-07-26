export function SkeletonLine({ className = '', width = '100%' }) {
  return <div className={`skeleton skeleton-text ${className}`} style={{ width }} />;
}

export function SkeletonCard({ lines = 3 }) {
  return (
    <div className="glass-card p-5 space-y-4">
      <div className="flex items-center gap-3">
        <div className="skeleton skeleton-badge" />
        <div className="skeleton skeleton-text flex-1" />
      </div>
      <div className="space-y-2.5">
        {Array.from({ length: lines }).map((_, i) => (
          <SkeletonLine key={i} width={i === lines - 1 ? '60%' : '100%'} />
        ))}
      </div>
    </div>
  );
}

export function SkeletonEpic() {
  return (
    <div className="glass-card overflow-hidden">
      <div className="px-5 py-4 flex items-center gap-3">
        <div className="skeleton skeleton-badge" />
        <div className="skeleton skeleton-text flex-1" style={{ maxWidth: 240 }} />
      </div>
      <div className="px-5 pb-5 border-t border-subtle pt-4 space-y-4">
        <SkeletonLine width="90%" />
        <div className="ml-3 pl-4 border-l-2 border-white/[0.06] space-y-3">
          <div className="flex gap-2">
            <div className="skeleton skeleton-badge" style={{ width: 64 }} />
            <div className="skeleton skeleton-badge" style={{ width: 48 }} />
          </div>
          <SkeletonLine />
          <SkeletonLine width="75%" />
          <div className="p-3 rounded-xl bg-white/[0.02] space-y-2">
            <SkeletonLine width="40%" />
            <SkeletonLine />
            <SkeletonLine width="85%" />
          </div>
        </div>
      </div>
    </div>
  );
}

export function SkeletonDevCard() {
  return (
    <div className="glass-card p-5">
      <div className="flex items-start gap-4">
        <div className="skeleton skeleton-avatar" />
        <div className="flex-1 space-y-2">
          <div className="flex gap-2">
            <div className="skeleton skeleton-badge" />
            <div className="skeleton skeleton-badge" style={{ width: 96 }} />
          </div>
          <SkeletonLine width="70%" />
          <div className="grid grid-cols-2 gap-3 mt-3 sm:grid-cols-4 sm:gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="space-y-1">
                <SkeletonLine width="60%" />
                <SkeletonLine width="40%" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
