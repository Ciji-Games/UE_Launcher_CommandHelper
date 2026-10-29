import { useState, useMemo } from 'react';
import type { RangeCategoryBreakdown, TimerExcessDetail } from '../../types/traceAnalyzer';

interface CategoryBreakdownChartProps {
  categories: RangeCategoryBreakdown[];
  topTimers: TimerExcessDetail[];
  frameCount: number;
}

const CATEGORY_COLORS: Record<string, { fill: string; border: string; text: string }> = {
  'Rendering & GPU': { fill: '#f97316', border: '#ea580c', text: 'text-orange-400' },
  'Blueprints & Script': { fill: '#10b981', border: '#059669', text: 'text-emerald-400' },
  'UI & Slate': { fill: '#38bdf8', border: '#0284c7', text: 'text-sky-400' },
  'Garbage Collection': { fill: '#f43f5e', border: '#e11d48', text: 'text-rose-400' },
  'Animation & Physics': { fill: '#a855f7', border: '#9333ea', text: 'text-purple-400' },
  'Asset Loading & Streaming': { fill: '#fbbf24', border: '#d97706', text: 'text-amber-400' },
  'Other / Engine System': { fill: '#64748b', border: '#475569', text: 'text-slate-400' },
};

function getCategoryColor(cat: string) {
  return CATEGORY_COLORS[cat] || { fill: '#94a3b8', border: '#64748b', text: 'text-slate-400' };
}

export function CategoryBreakdownChart({
  categories,
  topTimers,
  frameCount,
}: CategoryBreakdownChartProps) {
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [hoveredCategory, setHoveredCategory] = useState<string | null>(null);

  // Filter top timers based on selected category (if selected)
  const filteredTimers = useMemo(() => {
    if (!selectedCategory) return topTimers.slice(0, 10);
    return topTimers
      .filter((t) => {
        if (selectedCategory === 'Rendering & GPU') {
          return ['GPU', 'Render CPU', 'RHI', 'ShaderCompile/PSO', 'Niagara/FX'].includes(t.bucket);
        }
        if (selectedCategory === 'Blueprints & Script') {
          return ['Blueprint', 'Spawning'].includes(t.bucket);
        }
        if (selectedCategory === 'UI & Slate') {
          return t.bucket === 'UI / Slate';
        }
        if (selectedCategory === 'Garbage Collection') {
          return t.bucket === 'GC';
        }
        if (selectedCategory === 'Animation & Physics') {
          return ['Animation', 'Physics'].includes(t.bucket);
        }
        if (selectedCategory === 'Asset Loading & Streaming') {
          return ['Loading', 'Streaming'].includes(t.bucket);
        }
        return !['GPU', 'Render CPU', 'RHI', 'ShaderCompile/PSO', 'Niagara/FX', 'Blueprint', 'Spawning', 'UI / Slate', 'GC', 'Animation', 'Physics', 'Loading', 'Streaming'].includes(t.bucket);
      })
      .slice(0, 10);
  }, [topTimers, selectedCategory]);

  // Compute SVG Donut paths
  const donutSlices = useMemo(() => {
    const totalPct = categories.reduce((sum, c) => sum + c.percentage, 0);
    if (totalPct <= 0.001) return [];

    let currentAngle = -Math.PI / 2; // Start from top 12 o'clock
    const radius = 60;
    const innerRadius = 38;
    const cx = 80;
    const cy = 80;

    return categories
      .filter((c) => c.percentage > 0.5)
      .map((cat) => {
        const sliceAngle = Math.min(cat.percentage / 100, 0.9999) * (Math.PI * 2);
        const endAngle = currentAngle + sliceAngle;

        // Coordinates
        const x1 = cx + radius * Math.cos(currentAngle);
        const y1 = cy + radius * Math.sin(currentAngle);
        const x2 = cx + radius * Math.cos(endAngle);
        const y2 = cy + radius * Math.sin(endAngle);

        const ix1 = cx + innerRadius * Math.cos(endAngle);
        const iy1 = cy + innerRadius * Math.sin(endAngle);
        const ix2 = cx + innerRadius * Math.cos(currentAngle);
        const iy2 = cy + innerRadius * Math.sin(currentAngle);

        const largeArc = sliceAngle > Math.PI ? 1 : 0;

        const pathData = [
          `M ${x1} ${y1}`,
          `A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2}`,
          `L ${ix1} ${iy1}`,
          `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${ix2} ${iy2}`,
          'Z',
        ].join(' ');

        currentAngle = endAngle;

        return {
          category: cat.category,
          percentage: cat.percentage,
          totalMs: cat.totalMs,
          avgMsPerFrame: cat.avgMsPerFrame,
          pathData,
        };
      });
  }, [categories]);

  const activeCategoryName = hoveredCategory || selectedCategory;
  const activeCategoryData = categories.find((c) => c.category === activeCategoryName);

  return (
    <div className="bg-slate-900/60 rounded border border-slate-700/60 p-4 flex flex-col gap-3.5 h-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-slate-200 text-sm">Fixed Timer Categories</span>
          {selectedCategory && (
            <button
              type="button"
              onClick={() => setSelectedCategory(null)}
              className="text-[11px] px-1.5 py-0.5 rounded bg-sky-950/60 text-sky-300 border border-sky-700/50 hover:bg-sky-900/80 transition-colors"
            >
              Clear Filter ({selectedCategory}) ✕
            </button>
          )}
        </div>
        <span className="text-xs text-slate-400">Click slice to filter timers</span>
      </div>

      {/* Donut Chart & Category Legend Row */}
      <div className="flex flex-col sm:flex-row items-center gap-4">
        {/* SVG Donut */}
        <div className="relative shrink-0 w-[160px] h-[160px] flex items-center justify-center">
          <svg width="160" height="160" viewBox="0 0 160 160" className="overflow-visible">
            {donutSlices.map((slice) => {
              const isSelected = selectedCategory === slice.category;
              const isHovered = hoveredCategory === slice.category;
              const color = getCategoryColor(slice.category);

              return (
                <path
                  key={slice.category}
                  d={slice.pathData}
                  fill={color.fill}
                  stroke={isSelected || isHovered ? '#ffffff' : color.border}
                  strokeWidth={isSelected || isHovered ? 2 : 1}
                  className="cursor-pointer transition-all duration-150 hover:opacity-90"
                  style={{
                    transform: isSelected || isHovered ? 'scale(1.04)' : 'scale(1)',
                    transformOrigin: '80px 80px',
                  }}
                  onMouseEnter={() => setHoveredCategory(slice.category)}
                  onMouseLeave={() => setHoveredCategory(null)}
                  onClick={() =>
                    setSelectedCategory((prev) => (prev === slice.category ? null : slice.category))
                  }
                />
              );
            })}
          </svg>

          {/* Center text in donut */}
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none text-center px-2">
            {activeCategoryData ? (
              <>
                <span className="text-xs font-bold font-mono text-slate-100">
                  {activeCategoryData.percentage.toFixed(0)}%
                </span>
                <span className="text-[10px] text-slate-400 leading-tight truncate max-w-[70px]">
                  {activeCategoryData.category.split(' ')[0]}
                </span>
              </>
            ) : (
              <>
                <span className="text-xs font-bold text-slate-300">7 Buckets</span>
                <span className="text-[10px] text-slate-400">Active</span>
              </>
            )}
          </div>
        </div>

        {/* Category Legend List */}
        <div className="flex-1 grid grid-cols-1 gap-1 w-full text-xs">
          {categories.map((cat) => {
            const color = getCategoryColor(cat.category);
            const isSelected = selectedCategory === cat.category;
            const isHovered = hoveredCategory === cat.category;

            return (
              <button
                key={cat.category}
                type="button"
                onClick={() =>
                  setSelectedCategory((prev) => (prev === cat.category ? null : cat.category))
                }
                onMouseEnter={() => setHoveredCategory(cat.category)}
                onMouseLeave={() => setHoveredCategory(null)}
                className={`flex items-center justify-between px-2 py-1 rounded text-left transition-colors ${
                  isSelected
                    ? 'bg-slate-700/80 ring-1 ring-sky-400'
                    : isHovered
                    ? 'bg-slate-800/80'
                    : 'bg-slate-800/30 hover:bg-slate-800/60'
                }`}
              >
                <div className="flex items-center gap-1.5 truncate">
                  <span
                    className="w-2.5 h-2.5 rounded-sm shrink-0"
                    style={{ backgroundColor: color.fill }}
                  />
                  <span className={`truncate font-medium ${isSelected ? 'text-white' : 'text-slate-300'}`}>
                    {cat.category}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0 font-mono text-[11px]">
                  <span className="text-slate-400">{cat.totalMs.toFixed(1)} ms</span>
                  <span className={`font-semibold ${color.text}`}>{cat.percentage.toFixed(0)}%</span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Top Timers Drilldown Table */}
      <div className="flex flex-col gap-1 pt-2 border-t border-slate-800">
        <div className="flex items-center justify-between text-xs text-slate-400 pb-0.5">
          <span className="font-medium text-slate-300">
            Top Timers {selectedCategory ? `in ${selectedCategory}` : 'in Selected Range'}
          </span>
          <span className="text-[11px] text-slate-500">
            {filteredTimers.length} timer{filteredTimers.length !== 1 ? 's' : ''} shown
          </span>
        </div>

        {filteredTimers.length === 0 ? (
          <div className="text-xs text-slate-500 py-2 text-center bg-slate-800/20 rounded">
            No specific timers recorded for this category in the active window.
          </div>
        ) : (
          <div className="overflow-x-auto max-h-[140px] overflow-y-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-slate-800 text-[11px] text-slate-400">
                  <th className="py-1 px-1.5 font-medium">Timer Name</th>
                  <th className="py-1 px-1.5 font-medium">Bucket</th>
                  <th className="py-1 px-1.5 font-medium text-right">Total ms</th>
                  <th className="py-1 px-1.5 font-medium text-right">Calls</th>
                  <th className="py-1 px-1.5 font-medium text-right">ms/frame</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {filteredTimers.map((t, idx) => {
                  const avgPerFrame = frameCount > 0 ? t.episodeExclMs / frameCount : 0;
                  return (
                    <tr key={`${t.timerName}-${idx}`} className="hover:bg-slate-800/40 font-mono text-[11px]">
                      <td className="py-1 px-1.5 text-slate-200 font-sans truncate max-w-[180px]" title={t.timerName}>
                        {t.timerName}
                      </td>
                      <td className="py-1 px-1.5 text-slate-400 text-[10px]">
                        <span className="px-1 py-0.2 rounded bg-slate-800 border border-slate-700">
                          {t.bucket}
                        </span>
                      </td>
                      <td className="py-1 px-1.5 text-right text-amber-300 font-semibold">
                        {t.episodeExclMs.toFixed(1)}
                      </td>
                      <td className="py-1 px-1.5 text-right text-slate-400">{t.callCount}</td>
                      <td className="py-1 px-1.5 text-right text-slate-300">{avgPerFrame.toFixed(2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
