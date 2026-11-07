import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChunkState, Episode, FrameSeriesResponse, Issue, IssueWithOccurrences, Occurrence, TraceBookmark, TraceSummary } from '../../types/traceAnalyzer';
import { RULE_COLORS, getRuleDisplayLabel } from '../../utils/ruleDisplay';

interface FrameGraphProps {
  summary?: TraceSummary | null;
  durationS: number;
  targetMs: number;
  episodes?: Episode[];
  bookmarks?: TraceBookmark[];
  chunks?: ChunkState[];
  issues?: IssueWithOccurrences[];
  selectedRange?: [number, number] | null;
  onSelectRange?: (range: [number, number] | null) => void;
  onSetFrontier?: (startS: number) => void;
  fetchFrameSeries: (startS: number, endS: number, maxItems?: number) => Promise<FrameSeriesResponse | null>;
}


function formatTime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || Number.isNaN(seconds)) {
    return '0.00s';
  }
  const s = Math.max(0, seconds);
  if (s < 60) {
    return `${s.toFixed(2)}s`;
  }
  const mins = Math.floor(s / 60);
  const secs = (s % 60).toFixed(1);
  return `${mins}m ${secs}s`;
}

function getNiceTimeStep(vDuration: number, targetTicks = 6): number {
  const roughStep = Math.max(vDuration / targetTicks, 0.001);
  const niceSteps = [
    0.01, 0.02, 0.05, 0.1, 0.2, 0.5,
    1, 2, 5, 10, 15, 20, 30,
    60, 120, 300, 600, 900, 1800, 3600,
  ];
  for (const s of niceSteps) {
    if (s >= roughStep) {
      return s;
    }
  }
  const magnitude = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const normalized = roughStep / magnitude;
  if (normalized <= 1) return 1 * magnitude;
  if (normalized <= 2) return 2 * magnitude;
  if (normalized <= 5) return 5 * magnitude;
  return 10 * magnitude;
}

function formatTickTime(seconds: number, step: number): string {
  const s = Math.max(0, seconds);
  if (s < 60) {
    if (step >= 1) {
      return `${Math.round(s)}s`;
    }
    const decimals = step >= 0.1 ? 1 : 2;
    return `${s.toFixed(decimals)}s`;
  }
  const mins = Math.floor(s / 60);
  const remSecs = s % 60;
  if (step >= 1) {
    const secInt = Math.round(remSecs);
    if (secInt === 60) {
      return `${mins + 1}m 00s`;
    }
    return `${mins}m ${secInt < 10 ? '0' : ''}${secInt}s`;
  }
  const decimals = step >= 0.1 ? 1 : 2;
  return `${mins}m ${remSecs.toFixed(decimals)}s`;
}

function formatBookmarkName(name: string | undefined, timeS: number): string {
  if (!name || name.trim().toLowerCase() === 'bookmark') {
    return `Marker ${timeS.toFixed(2)}s`;
  }
  return name;
}

interface BookmarkChipsListProps {
  bookmarks: TraceBookmark[];
  durationS: number;
  onSelectRange?: (range: [number, number] | null) => void;
}

function BookmarkChipsList({ bookmarks, durationS, onSelectRange }: BookmarkChipsListProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [visibleCount, setVisibleCount] = useState<number>(bookmarks.length);
  const containerRef = useRef<HTMLDivElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);

  const updateVisibleCount = useCallback(() => {
    if (!containerRef.current || !ghostRef.current) return;
    const width = containerRef.current.clientWidth;
    if (width <= 0) return;

    ghostRef.current.style.width = `${width}px`;

    const ghostItems = Array.from(
      ghostRef.current.querySelectorAll<HTMLElement>('[data-ghost-bm="true"]')
    );
    const ghostMore = ghostRef.current.querySelector<HTMLElement>('[data-ghost-more="true"]');

    if (ghostItems.length === 0) {
      setVisibleCount(bookmarks.length);
      return;
    }

    // Determine row tops (clustering by tolerance of 4px)
    const lineTops: number[] = [];
    const itemLineIndices: number[] = [];

    for (let i = 0; i < ghostItems.length; i++) {
      const top = ghostItems[i].offsetTop;
      let lineIdx = lineTops.findIndex((t) => Math.abs(t - top) < 4);
      if (lineIdx === -1) {
        lineTops.push(top);
        lineTops.sort((a, b) => a - b);
        lineIdx = lineTops.findIndex((t) => Math.abs(t - top) < 4);
      }
      itemLineIndices[i] = lineIdx;
    }

    // If 2 lines or fewer, everything fits
    if (lineTops.length <= 2) {
      setVisibleCount(bookmarks.length);
      return;
    }

    // If more than 2 lines, we find how many items fit on lines 0 and 1 with the "+X more" button
    const moreBtnWidth = ghostMore ? ghostMore.offsetWidth : 75;
    const gap = 6;
    const maxLine2Right = width - moreBtnWidth - gap;

    let fittingCount = 0;
    for (let i = 0; i < ghostItems.length; i++) {
      const lineIdx = itemLineIndices[i];
      if (lineIdx === 0) {
        fittingCount = i + 1;
      } else if (lineIdx === 1) {
        const itemRight = ghostItems[i].offsetLeft + ghostItems[i].offsetWidth;
        if (itemRight <= maxLine2Right) {
          fittingCount = i + 1;
        } else {
          break;
        }
      } else {
        break;
      }
    }

    setVisibleCount(Math.max(1, fittingCount));
  }, [bookmarks]);

  useEffect(() => {
    updateVisibleCount();

    if (!containerRef.current) return;
    const observer = new ResizeObserver(() => {
      updateVisibleCount();
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [updateVisibleCount]);

  if (bookmarks.length === 0) return null;

  const hasOverflow = visibleCount < bookmarks.length;
  const displayedBookmarks = isExpanded ? bookmarks : bookmarks.slice(0, visibleCount);
  const hiddenCount = bookmarks.length - visibleCount;

  return (
    <div className="relative w-full">
      {/* Invisible Ghost container for accurate 2-line overflow measurement */}
      <div
        ref={ghostRef}
        aria-hidden="true"
        className="invisible pointer-events-none absolute top-0 left-0 flex flex-wrap items-center gap-1.5 opacity-0 z-[-999]"
        style={{ width: '100%' }}
      >
        <span className="text-[11px] font-semibold shrink-0">📌 Bookmarks:</span>
        {bookmarks.map((bm) => (
          <div
            key={bm.id}
            data-ghost-bm="true"
            className="px-2 py-0.5 rounded text-[10px] flex items-center gap-1 shrink-0"
          >
            <span className="font-medium truncate max-w-[130px]">{formatBookmarkName(bm.name, bm.startS)}</span>
            <span className="font-mono text-[9px]">({formatTime(bm.startS)})</span>
          </div>
        ))}
        <button
          type="button"
          data-ghost-more="true"
          className="px-2 py-0.5 rounded text-[10px] font-semibold flex items-center gap-1 shrink-0"
        >
          +999 more
        </button>
      </div>

      {/* Visible bookmarks bar */}
      <div
        ref={containerRef}
        className="flex flex-wrap items-center gap-1.5 w-full transition-all duration-200"
      >
        <span className="text-[11px] text-purple-300 font-semibold shrink-0 flex items-center gap-1">
          📌 <span>Bookmarks:</span>
        </span>

        {displayedBookmarks.map((bm) => (
          <button
            key={bm.id}
            type="button"
            onClick={() => {
              const bStart = Math.max(0, bm.startS - 2.5);
              const bEnd = Math.min(durationS, bm.startS + Math.max(bm.durationS, 2.5));
              onSelectRange?.([bStart, bEnd]);
            }}
            className="px-2 py-0.5 rounded bg-purple-950/70 border border-purple-600/50 hover:bg-purple-900 text-purple-200 text-[10px] flex items-center gap-1 shrink-0 transition-colors shadow-sm cursor-pointer"
            title={`${bm.name} at ${formatTime(bm.startS)} (click to inspect range)`}
          >
            <span className="font-medium truncate max-w-[130px]">{formatBookmarkName(bm.name, bm.startS)}</span>
            <span className="text-purple-400 font-mono text-[9px]">({formatTime(bm.startS)})</span>
          </button>
        ))}

        {hasOverflow && !isExpanded && (
          <button
            type="button"
            onClick={() => setIsExpanded(true)}
            className="px-2 py-0.5 rounded bg-purple-900/80 border border-purple-500/60 hover:bg-purple-800 text-purple-100 text-[10px] font-semibold flex items-center gap-1 shrink-0 transition-all shadow-sm cursor-pointer hover:border-purple-400"
            title={`Show ${hiddenCount} more bookmark${hiddenCount > 1 ? 's' : ''}`}
          >
            <span>+{hiddenCount} more</span>
            <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        )}

        {hasOverflow && isExpanded && (
          <button
            type="button"
            onClick={() => setIsExpanded(false)}
            className="px-2 py-0.5 rounded bg-purple-900/80 border border-purple-500/60 hover:bg-purple-800 text-purple-100 text-[10px] font-semibold flex items-center gap-1 shrink-0 transition-all shadow-sm cursor-pointer hover:border-purple-400"
            title="Collapse back to 2 lines"
          >
            <span>Show less</span>
            <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 15l7-7 7 7" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}

const PAD_L = 92;
const PAD_R = 20;
const PAD_T = 24;
const PAD_B = 25;

export function FrameGraph({
  summary,
  durationS,
  targetMs,
  episodes = [],
  bookmarks = [],
  chunks = [],
  issues = [],
  selectedRange = null,
  onSelectRange,
  onSetFrontier,
  fetchFrameSeries,
}: FrameGraphProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Viewport bounds in seconds
  const [userViewRange, setUserViewRange] = useState<[number, number] | null>(null);

  const viewRange: [number, number] = useMemo(() => {
    return userViewRange ?? [0, Math.max(durationS, 1)];
  }, [userViewRange, durationS]);

  const setViewRange = useCallback((val: [number, number] | ((prev: [number, number]) => [number, number])) => {
    if (typeof val === 'function') {
      setUserViewRange((prev) => val(prev ?? [0, Math.max(durationS, 1)]));
    } else {
      setUserViewRange(val);
    }
  }, [durationS]);

  const [seriesData, setSeriesData] = useState<FrameSeriesResponse | null>(null);
  const [showGame, setShowGame] = useState(false);
  const [showRender, setShowRender] = useState(false);
  const [showGpu, setShowGpu] = useState(false);
  const [scaleMode, setScaleMode] = useState<'p99' | 'fit'>('p99');

  const [hoverInfo, setHoverInfo] = useState<{
    x: number;
    y: number;
    timeS: number;
    frameMs: number;
    minMs?: number;
    maxMs?: number;
    gameMs?: number;
    renderMs?: number;
    gpuMs?: number;
    bookmarkName?: string;
    hitchNum?: number;
  } | null>(null);
  const [showAllIssues, setShowAllIssues] = useState(false);

  // Drag / pan / selection interaction mode state
  const dragModeRef = useRef<'none' | 'pan' | 'brush' | 'handle_left' | 'handle_right'>('none');
  const dragStartXRef = useRef(0);
  const dragStartRangeRef = useRef<[number, number]>([0, 1]);
  const dragStartSelectedRef = useRef<[number, number] | null>(null);

  // Fetch frame series data whenever view range changes
  useEffect(() => {
    let active = true;
    const [startS, endS] = viewRange;

    const timer = setTimeout(() => {
      fetchFrameSeries(startS, endS, 800).then((res) => {
        if (active && res) {
          setSeriesData(res);
        }
      });
    }, 40);

    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [viewRange, fetchFrameSeries]);

  const sortedEpisodes = useMemo(() => {
    return [...episodes].sort((a, b) => a.startS - b.startS);
  }, [episodes]);

  const episodeIndexMap = useMemo(() => {
    const map = new Map<number, number>();
    sortedEpisodes.forEach((ep, idx) => {
      map.set(ep.id, idx + 1);
    });
    return map;
  }, [sortedEpisodes]);

  const pixelToTime = useCallback((px: number, totalW: number) => {
    const graphW = Math.max(totalW - PAD_L - PAD_R, 1);
    const ratio = Math.max(0, Math.min(1, (px - PAD_L) / graphW));
    const [vStart, vEnd] = viewRange;
    return vStart + ratio * (vEnd - vStart);
  }, [viewRange]);

  const timeToPixel = useCallback((t: number, totalW: number) => {
    const graphW = Math.max(totalW - PAD_L - PAD_R, 1);
    const [vStart, vEnd] = viewRange;
    const vDuration = Math.max(vEnd - vStart, 0.001);
    return PAD_L + ((t - vStart) / vDuration) * graphW;
  }, [viewRange]);

  // Canvas drawing
  const renderCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.width / dpr;
    const height = canvas.height / dpr;

    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const [vStart, vEnd] = viewRange;
    const vDuration = Math.max(vEnd - vStart, 0.001);

    const padL = PAD_L;
    const padR = PAD_R;
    const padT = PAD_T;
    const padB = PAD_B;

    const graphW = width - padL - padR;
    const graphH = height - padT - padB;

    // Determine max Y scale (ms)
    let maxY = Math.max(targetMs * 4.2, 45.0);
    let absoluteMaxMs = maxY;

    if (seriesData) {
      if (seriesData.isBucketed && seriesData.buckets.length > 0) {
        for (const b of seriesData.buckets) {
          if (b.maxMs > absoluteMaxMs) absoluteMaxMs = b.maxMs;
        }
        if (scaleMode === 'fit') {
          maxY = Math.max(maxY, absoluteMaxMs * 1.12);
        } else {
          const sortedAvgs = seriesData.buckets.map((b) => b.avgMs).sort((a, b) => a - b);
          const p99_5 = sortedAvgs[Math.floor(sortedAvgs.length * 0.995)] ?? sortedAvgs[sortedAvgs.length - 1];
          maxY = Math.max(maxY, p99_5 * 1.35);
        }
      } else if (!seriesData.isBucketed && seriesData.points.length > 0) {
        for (const p of seriesData.points) {
          if (p.frameMs > absoluteMaxMs) absoluteMaxMs = p.frameMs;
        }
        if (scaleMode === 'fit') {
          maxY = Math.max(maxY, absoluteMaxMs * 1.12);
        } else {
          const sortedFrames = seriesData.points.map((p) => p.frameMs).sort((a, b) => a - b);
          const p99_5 = sortedFrames[Math.floor(sortedFrames.length * 0.995)] ?? sortedFrames[sortedFrames.length - 1];
          maxY = Math.max(maxY, p99_5 * 1.35);
        }
      }
    }

    const timeToX = (t: number) => padL + ((t - vStart) / vDuration) * graphW;
    const msToY = (ms: number) => {
      const clampedMs = Math.min(ms, maxY);
      return padT + graphH - (clampedMs / maxY) * graphH;
    };
    const baseBottomY = padT + graphH;

    // Draw grid lines & budget guides
    const budgets = [
      { ms: targetMs, color: '#38bdf8', label: `${targetMs.toFixed(1)} ms (${Math.round(1000 / targetMs)} fps)` },
      { ms: targetMs * 2, color: '#fbbf24', label: `${(targetMs * 2).toFixed(1)} ms (2x)` },
      { ms: targetMs * 4, color: '#f87171', label: `${(targetMs * 4).toFixed(1)} ms (4x)` },
    ];

    ctx.lineWidth = 1;
    for (const b of budgets) {
      const y = msToY(b.ms);
      if (y >= padT && y <= padT + graphH) {
        ctx.strokeStyle = `${b.color}40`;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(padL + graphW, y);
        ctx.stroke();

        ctx.fillStyle = b.color;
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(b.label, padL - 8, y + 3);
      }
    }
    ctx.setLineDash([]);

    // Draw Slow Region shaded bands
    for (const ep of episodes) {
      if (ep.kind === 'slow_region') {
        const x1 = Math.max(timeToX(ep.startS), padL);
        const x2 = Math.min(timeToX(ep.endS), padL + graphW);
        if (x2 > x1) {
          ctx.fillStyle = 'rgba(245, 158, 11, 0.12)';
          ctx.fillRect(x1, padT, x2 - x1, graphH);
        }
      }
    }

    // Draw Chunk State Overlays (Analysing vs Queued)
    if (chunks && chunks.length > 0 && durationS > 0) {
      const totalChunkFrames = chunks.reduce((acc, c) => Math.max(acc, c.frameTo + 1), 1);
      const secPerFrame = durationS / totalChunkFrames;

      for (const chunk of chunks) {
        if (chunk.state === 'done') continue;

        const chunkStartS = chunk.frameFrom * secPerFrame;
        const chunkEndS = (chunk.frameTo + 1) * secPerFrame;

        const cx1 = Math.max(padL, timeToX(chunkStartS));
        const cx2 = Math.min(padL + graphW, timeToX(chunkEndS));
        const cw = cx2 - cx1;

        if (cw <= 0) continue;

        if (chunk.state === 'running') {
          // Analysing state: desaturated blue with moving/dashed border
          ctx.fillStyle = 'rgba(56, 189, 248, 0.10)';
          ctx.fillRect(cx1, padT, cw, graphH);
          ctx.strokeStyle = 'rgba(56, 189, 248, 0.35)';
          ctx.setLineDash([4, 4]);
          ctx.strokeRect(cx1, padT, cw, graphH);
          ctx.setLineDash([]);
        } else if (chunk.state === 'queued') {
          // Queued state: greyed overlay
          ctx.fillStyle = 'rgba(15, 23, 42, 0.50)';
          ctx.fillRect(cx1, padT, cw, graphH);
          ctx.strokeStyle = 'rgba(100, 116, 139, 0.2)';
          ctx.setLineDash([2, 4]);
          ctx.strokeRect(cx1, padT, cw, graphH);
          ctx.setLineDash([]);
        }
      }
    }

    // Draw Frame Series (Buckets or Individual Points)
    if (seriesData) {
      if (seriesData.isBucketed && seriesData.buckets.length > 0) {
        for (const b of seriesData.buckets) {
          const x1 = timeToX(b.t0);
          const x2 = timeToX(b.t1);
          const rawBarW = Math.max(x2 - x1, 1);
          const isOffScale = b.maxMs > maxY;

          const yMin = msToY(b.minMs);
          const yMax = msToY(b.maxMs);
          const yAvg = msToY(b.avgMs);

          const barGap = rawBarW >= 4.0 ? 0.5 : 0;
          const barW = Math.max(rawBarW - barGap, 1);

          let barColor = 'rgba(56, 189, 248, 0.75)'; // sky
          let maxRangeColor = 'rgba(56, 189, 248, 0.25)';
          if (b.avgMs >= targetMs * 2) {
            barColor = 'rgba(239, 68, 68, 0.85)'; // red
            maxRangeColor = 'rgba(239, 68, 68, 0.35)';
          } else if (b.avgMs >= targetMs * 1.25) {
            barColor = 'rgba(245, 158, 11, 0.8)'; // amber
            maxRangeColor = 'rgba(245, 158, 11, 0.3)';
          }

          // 1. Min-max range bar
          ctx.fillStyle = maxRangeColor;
          ctx.fillRect(x1, yMax, barW, Math.max(baseBottomY - yMax, 1));

          // 2. Average body bar
          ctx.fillStyle = barColor;
          ctx.fillRect(x1, yAvg, barW, Math.max(baseBottomY - yAvg, 1));

          if (rawBarW >= 3.5) {
            ctx.strokeStyle = '#020617';
            ctx.lineWidth = 1;
            ctx.strokeRect(x1, yAvg, barW, Math.max(baseBottomY - yAvg, 1));
          }

          // 3. Top peak indicator
          if (isOffScale) {
            ctx.fillStyle = '#ef4444';
            ctx.fillRect(x1, padT, barW, 2.5);
            if (barW >= 6) {
              ctx.fillStyle = '#fca5a5';
              ctx.font = 'bold 9px sans-serif';
              ctx.textAlign = 'center';
              ctx.fillText('▲', x1 + barW / 2, padT - 2);
            }
          } else if (yMin - yMax > 2) {
            ctx.fillStyle = '#f8fafc';
            ctx.fillRect(x1, yMax, barW, 1.5);
          }
        }
      } else if (!seriesData.isBucketed && seriesData.points.length > 0) {
        const points = seriesData.points;

        for (let i = 0; i < points.length; i++) {
          const p = points[i];
          const nextP = points[i + 1];
          const frameDurS = (nextP && nextP.t > p.t && nextP.t - p.t < 2.0)
            ? (nextP.t - p.t)
            : Math.max(p.frameMs / 1000, 0.001);

          const x1 = timeToX(p.t);
          const x2 = timeToX(p.t + frameDurS);
          const rawBarW = Math.max(x2 - x1, 1.0);

          // Subtle gap and border separation below certain zoom threshold
          const showBorder = rawBarW >= 3.0;
          const barGap = rawBarW >= 6.0 ? 1.0 : (rawBarW >= 3.5 ? 0.5 : 0);
          const barW = Math.max(rawBarW - barGap, 1.0);

          const y = msToY(p.frameMs);
          const barH = Math.max(baseBottomY - y, 1.0);
          const isOffScale = p.frameMs > maxY;

          let color = '#38bdf8'; // sky
          if (p.frameMs >= targetMs * 2) {
            color = '#f87171'; // red
          } else if (p.frameMs >= targetMs * 1.25) {
            color = '#fbbf24'; // amber
          }

          ctx.fillStyle = color;
          ctx.fillRect(x1, y, barW, barH);

          // Black border on the bars when zoomed below threshold to clearly separate adjacent bars
          if (showBorder) {
            ctx.strokeStyle = '#020617';
            ctx.lineWidth = 1;
            ctx.strokeRect(x1, y, barW, barH);
          }

          if (isOffScale) {
            ctx.fillStyle = '#ef4444';
            ctx.fillRect(x1, padT, barW, 2.5);
            ctx.fillStyle = '#fca5a5';
            ctx.font = 'bold 8px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('▲', x1 + barW / 2, padT - 2);
          }

          if (showGame && p.gameMs) {
            const gy = msToY(p.gameMs);
            ctx.fillStyle = '#34d399'; // emerald
            ctx.fillRect(x1, gy, barW, Math.min(2, barH));
          }
          if (showRender && p.renderMs) {
            const ry = msToY(p.renderMs);
            ctx.fillStyle = '#a78bfa'; // purple
            ctx.fillRect(x1, ry, barW, Math.min(2, barH));
          }
          if (showGpu && p.gpuMs) {
            const py = msToY(p.gpuMs);
            ctx.fillStyle = '#fb923c'; // orange
            ctx.fillRect(x1, py, barW, Math.min(2, barH));
          }
        }
      }
    }

    // Draw Hitch Markers: Show #N only for the worst 5 in view, others plain ticks; hide overlapping labels
    const hitchesInView = episodes.filter((ep) => {
      if (ep.kind !== 'hitch') return false;
      const x = timeToX(ep.startS);
      return x >= padL && x <= padL + graphW;
    });

    const worst5Hitches = [...hitchesInView]
      .sort((a, b) => b.peakMs - a.peakMs)
      .slice(0, 5);

    const worst5SortedByX = worst5Hitches.sort((a, b) => a.startS - b.startS);
    const labeledHitchIds = new Set<number>();
    let lastLabelX = -999;
    for (const h of worst5SortedByX) {
      const hx = timeToX(h.startS);
      if (hx - lastLabelX >= 26) {
        labeledHitchIds.add(h.id);
        lastLabelX = hx;
      }
    }

    for (const ep of episodes) {
      if (ep.kind === 'hitch') {
        const x = timeToX(ep.startS);
        if (x >= padL && x <= padL + graphW) {
          const y = msToY(ep.peakMs) - 6;
          const markerNum = episodeIndexMap.get(ep.id) || 1;
          const showLabel = labeledHitchIds.has(ep.id);

          ctx.fillStyle = '#ef4444';
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x - 4, y - 7);
          ctx.lineTo(x + 4, y - 7);
          ctx.closePath();
          ctx.fill();

          if (showLabel) {
            ctx.fillStyle = '#fca5a5';
            ctx.font = 'bold 9px monospace';
            ctx.textAlign = 'center';
            ctx.fillText(`#${markerNum}`, x, y - 8);
          }
        }
      }
    }

    // Draw Engine Bookmarks (Triangle Pins & Vertical Guide Lines)
    for (const bm of bookmarks) {
      const bx = timeToX(bm.startS);
      if (bx >= padL - 10 && bx <= padL + graphW + 10) {
        // Vertical dashed pin guideline
        ctx.strokeStyle = 'rgba(168, 85, 247, 0.45)'; // Purple accent
        ctx.lineWidth = 1;
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(bx, padT);
        ctx.lineTo(bx, padT + graphH);
        ctx.stroke();
        ctx.setLineDash([]);

        // Top Triangle Pin (pointing down into the graph)
        ctx.fillStyle = '#c084fc';
        ctx.beginPath();
        ctx.moveTo(bx, padT);
        ctx.lineTo(bx - 5, padT - 8);
        ctx.lineTo(bx + 5, padT - 8);
        ctx.closePath();
        ctx.fill();

        // Pin badge circle
        ctx.fillStyle = '#7e22ce';
        ctx.beginPath();
        ctx.arc(bx, padT - 11, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = '#e9d5ff';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // Draw Selected Range (Brushing Box & Drag Handles)
    if (selectedRange) {
      const [s0, s1] = selectedRange;
      const minS = Math.min(s0, s1);
      const maxS = Math.max(s0, s1);

      const sx1 = Math.max(timeToX(minS), padL);
      const sx2 = Math.min(timeToX(maxS), padL + graphW);

      if (sx2 > sx1) {
        // Selection shaded background
        ctx.fillStyle = 'rgba(56, 189, 248, 0.16)';
        ctx.fillRect(sx1, padT, sx2 - sx1, graphH);

        // Selection boundary borders
        ctx.strokeStyle = '#38bdf8';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(sx1, padT, sx2 - sx1, graphH);

        // Left Handle Bar & Grip
        ctx.fillStyle = '#38bdf8';
        ctx.fillRect(sx1 - 2, padT + graphH / 2 - 12, 4, 24);

        // Right Handle Bar & Grip
        ctx.fillRect(sx2 - 2, padT + graphH / 2 - 12, 4, 24);

        // Top range pill label inside graph
        const rangeDur = maxS - minS;
        const pillText = `${formatTime(minS)} – ${formatTime(maxS)} (${rangeDur.toFixed(2)}s)`;
        ctx.font = '10px monospace';
        const textW = ctx.measureText(pillText).width;
        const pillX = Math.max(padL + 4, Math.min(padL + graphW - textW - 12, (sx1 + sx2) / 2 - textW / 2 - 4));

        ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
        ctx.fillRect(pillX, padT + 4, textW + 8, 16);
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.6)';
        ctx.lineWidth = 1;
        ctx.strokeRect(pillX, padT + 4, textW + 8, 16);

        ctx.fillStyle = '#38bdf8';
        ctx.textAlign = 'left';
        ctx.fillText(pillText, pillX + 4, padT + 16);
      }
    }

    // Draw X-axis time labels with round seconds
    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 1;

    const step = getNiceTimeStep(vDuration, Math.max(3, Math.min(8, Math.floor(graphW / 120))));
    const firstTick = Math.ceil(vStart / step) * step;
    const lastTick = Math.floor(vEnd / step) * step;

    for (let t = firstTick; t <= lastTick + step * 0.001; t += step) {
      const x = timeToX(t);
      if (x >= padL + 12 && x <= padL + graphW - 12) {
        // Small tick mark on axis line
        ctx.beginPath();
        ctx.moveTo(x, padT + graphH);
        ctx.lineTo(x, padT + graphH + 4);
        ctx.stroke();

        ctx.fillText(formatTickTime(t, step), x, padT + graphH + 16);
      }
    }

    // Frame axis line
    ctx.beginPath();
    ctx.moveTo(padL, padT + graphH);
    ctx.lineTo(padL + graphW, padT + graphH);
    ctx.stroke();

    ctx.restore();
  }, [
    viewRange,
    seriesData,
    targetMs,
    episodes,
    episodeIndexMap,
    bookmarks,
    selectedRange,
    showGame,
    showRender,
    showGpu,
    scaleMode,
    chunks,
    durationS,
  ]);

  // Handle ResizeObserver & Canvas resolution
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const updateSize = () => {
      const rect = container.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const dpr = window.devicePixelRatio || 1;
      const newW = Math.floor(rect.width * dpr);
      const newH = Math.floor(rect.height * dpr);
      if (canvas.width !== newW || canvas.height !== newH) {
        canvas.width = newW;
        canvas.height = newH;
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
      }
      renderCanvas();
    };

    updateSize();

    const observer = new ResizeObserver(() => {
      updateSize();
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, [renderCanvas]);

  useEffect(() => {
    renderCanvas();
  }, [renderCanvas]);

  // Mouse wheel zoom
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onNativeWheel = (e: WheelEvent) => {
      e.preventDefault();
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left - PAD_L;
      const graphW = Math.max(1, rect.width - PAD_L - PAD_R);
      if (graphW <= 0) return;

      const mouseRatio = Math.max(0, Math.min(1, mouseX / graphW));
      const [vStart, vEnd] = viewRange;
      const vDuration = vEnd - vStart;

      const zoomFactor = e.deltaY < 0 ? 0.75 : 1.33;
      const effectiveDuration = Math.max(durationS, 1);
      const newDuration = Math.max(0.1, Math.min(effectiveDuration, vDuration * zoomFactor));

      const centerT = vStart + mouseRatio * vDuration;
      let newStart = centerT - mouseRatio * newDuration;
      let newEnd = newStart + newDuration;

      if (newStart < 0) {
        newStart = 0;
        newEnd = Math.min(effectiveDuration, newDuration);
      }
      if (newEnd > effectiveDuration) {
        newEnd = effectiveDuration;
        newStart = Math.max(0, effectiveDuration - newDuration);
      }

      setViewRange([newStart, newEnd]);
    };

    container.addEventListener('wheel', onNativeWheel, { passive: false });
    return () => {
      container.removeEventListener('wheel', onNativeWheel);
    };
  }, [viewRange, durationS, setViewRange]);

  // Mouse down interaction
  const handleMouseDown = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;

    // Check if middle click or Alt/Space key: Pan mode
    if (e.button === 1 || e.altKey) {
      dragModeRef.current = 'pan';
      dragStartXRef.current = e.clientX;
      dragStartRangeRef.current = [...viewRange];
      return;
    }

    // Check if clicking near bookmarks (within 10px)
    const hitBookmark = bookmarks.find((bm) => {
      const bx = timeToPixel(bm.startS, rect.width);
      return Math.abs(x - bx) < 10;
    });

    if (hitBookmark) {
      const bStart = Math.max(0, hitBookmark.startS - 2.5);
      const bEnd = Math.min(durationS, hitBookmark.startS + Math.max(hitBookmark.durationS, 2.5));
      onSelectRange?.([bStart, bEnd]);
      return;
    }

    // Check if clicking near selection handles
    if (selectedRange) {
      const [s0, s1] = selectedRange;
      const minS = Math.min(s0, s1);
      const maxS = Math.max(s0, s1);
      const pxLeft = timeToPixel(minS, rect.width);
      const pxRight = timeToPixel(maxS, rect.width);

      if (Math.abs(x - pxLeft) < 8) {
        dragModeRef.current = 'handle_left';
        dragStartSelectedRef.current = [minS, maxS];
        return;
      }
      if (Math.abs(x - pxRight) < 8) {
        dragModeRef.current = 'handle_right';
        dragStartSelectedRef.current = [minS, maxS];
        return;
      }
    }

    // Otherwise: Start Primary Range Brushing (do not fire onSelectRange yet until drag or click completion)
    dragModeRef.current = 'brush';
    dragStartXRef.current = x;
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const currentT = pixelToTime(x, rect.width);

    if (dragModeRef.current === 'brush') {
      if (Math.abs(x - dragStartXRef.current) >= 3) {
        const t0 = pixelToTime(dragStartXRef.current, rect.width);
        onSelectRange?.([Math.min(t0, currentT), Math.max(t0, currentT)]);
      }
    } else if (dragModeRef.current === 'handle_left' && dragStartSelectedRef.current) {
      const [, rightS] = dragStartSelectedRef.current;
      onSelectRange?.([Math.min(currentT, rightS - 0.01), rightS]);
    } else if (dragModeRef.current === 'handle_right' && dragStartSelectedRef.current) {
      const [leftS] = dragStartSelectedRef.current;
      onSelectRange?.([leftS, Math.max(currentT, leftS + 0.01)]);
    } else if (dragModeRef.current === 'pan') {
      const deltaPx = e.clientX - dragStartXRef.current;
      const graphW = Math.max(1, rect.width - PAD_L - PAD_R);
      const [startRange0, startRange1] = dragStartRangeRef.current;
      const duration = startRange1 - startRange0;
      const deltaT = (deltaPx / graphW) * duration;

      let newStart = startRange0 - deltaT;
      let newEnd = startRange1 - deltaT;

      if (newStart < 0) {
        newStart = 0;
        newEnd = duration;
      }
      if (newEnd > durationS) {
        newEnd = durationS;
        newStart = Math.max(0, durationS - duration);
      }

      setViewRange([newStart, newEnd]);
    } else {
      // Hover Tooltip Info
      // 1. Check hitch marker hover
      const hitHitch = episodes.find((ep) => {
        if (ep.kind !== 'hitch') return false;
        const hx = timeToPixel(ep.startS, rect.width);
        return Math.abs(x - hx) < 8;
      });

      if (hitHitch) {
        const markerNum = episodeIndexMap.get(hitHitch.id) || 1;
        setHoverInfo({
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
          timeS: hitHitch.startS,
          frameMs: hitHitch.peakMs,
          hitchNum: markerNum,
        });
        return;
      }

      // 2. Check bookmark hover
      const hitBm = bookmarks.find((bm) => {
        const bx = timeToPixel(bm.startS, rect.width);
        return Math.abs(x - bx) < 8;
      });

      if (hitBm) {
        setHoverInfo({
          x: e.clientX - rect.left,
          y: e.clientY - rect.top,
          timeS: hitBm.startS,
          frameMs: 0,
          bookmarkName: formatBookmarkName(hitBm.name, hitBm.startS),
        });
        return;
      }

      // 3. Check frame data hover
      if (seriesData && !seriesData.isBucketed) {
        const hoveredPoint = seriesData.points.find((p, idx) => {
          const nextP = seriesData.points[idx + 1];
          const durS = (nextP && nextP.t > p.t && nextP.t - p.t < 2.0)
            ? (nextP.t - p.t)
            : Math.max(p.frameMs / 1000, 0.001);
          return currentT >= p.t - 0.002 && currentT <= p.t + durS + 0.002;
        }) ?? seriesData.points.find((p) => Math.abs(p.t - currentT) < 0.03);

        if (hoveredPoint) {
          setHoverInfo({
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
            timeS: hoveredPoint.t,
            frameMs: hoveredPoint.frameMs,
            gameMs: hoveredPoint.gameMs,
            renderMs: hoveredPoint.renderMs,
            gpuMs: hoveredPoint.gpuMs,
          });
        } else {
          setHoverInfo(null);
        }
      } else if (seriesData && seriesData.isBucketed) {
        const bucket = seriesData.buckets.find((b) => currentT >= b.t0 && currentT <= b.t1);
        if (bucket) {
          setHoverInfo({
            x: e.clientX - rect.left,
            y: e.clientY - rect.top,
            timeS: (bucket.t0 + bucket.t1) / 2,
            frameMs: bucket.avgMs,
            minMs: bucket.minMs,
            maxMs: bucket.maxMs,
          });
        } else {
          setHoverInfo(null);
        }
      } else {
        setHoverInfo(null);
      }
    }
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    const wasBrushing = dragModeRef.current === 'brush';
    const isDrag = dragModeRef.current !== 'none';
    dragModeRef.current = 'none';

    if (!isDrag) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const t = pixelToTime(x, rect.width);

    if (wasBrushing) {
      if (Math.abs(x - dragStartXRef.current) < 4) {
        // Single tap / click:
        // 1. Check if clicking on an engine bookmark pin
        const hitBm = bookmarks.find((bm) => Math.abs(timeToPixel(bm.startS, rect.width) - x) < 10);
        if (hitBm) {
          const halfWin = 1.5;
          const wStart = Math.max(0, hitBm.startS - halfWin);
          const wEnd = Math.min(durationS, hitBm.startS + halfWin);
          onSelectRange?.([wStart, wEnd]);
        } else {
          // If clicked in an unanalysed / queued chunk, steer frontier
          if (chunks && chunks.length > 0 && durationS > 0) {
            const totalChunkFrames = chunks.reduce((acc, c) => Math.max(acc, c.frameTo + 1), 1);
            const secPerFrame = durationS / totalChunkFrames;
            const clickedChunk = chunks.find((c) => t >= c.frameFrom * secPerFrame && t <= (c.frameTo + 1) * secPerFrame);
            if (clickedChunk && clickedChunk.state !== 'done') {
              onSetFrontier?.(t);
            }
          }

          // Scope a comfortable 3-second context window around the clicked timestamp
          const halfWin = 1.5;
          const wStart = Math.max(0, t - halfWin);
          const wEnd = Math.min(durationS, t + halfWin);
          onSelectRange?.([wStart, wEnd]);
        }
      } else {
        const t0 = pixelToTime(dragStartXRef.current, rect.width);
        onSelectRange?.([Math.min(t0, t), Math.max(t0, t)]);
      }
    }
  };

  const handleResetZoom = () => {
    setViewRange([0, Math.max(durationS, 1)]);
  };

  const medianFps = summary && (summary.medianMs ?? 0) > 0 ? Math.round(1000 / summary.medianMs) : 0;

  return (
    <div className="flex flex-col gap-2 w-full min-h-[280px]">
      {/* Frame Graph Main Unified Container */}
      <div className="flex flex-col rounded-lg bg-slate-900/70 border border-slate-800 overflow-hidden shadow-sm">
        {/* Graph Header: Metrics Line + Zoom / View Controls */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 bg-slate-900/90 border-b border-slate-800 text-xs shrink-0">
          {/* Left: 4 Metrics Summary Line */}
          {summary ? (
            <div className="flex items-center gap-2 text-slate-400 text-xs font-mono flex-wrap">
              <span>
                Duration: <strong className="text-slate-200">{formatTime(summary.durationS)}</strong>
              </span>
              <span className="text-slate-600">•</span>
              <span>
                Median: <strong className="text-emerald-400">{medianFps} fps</strong> ({(summary.medianMs ?? 0).toFixed(1)} ms/frame)
              </span>
              <span className="text-slate-600">•</span>
              <span>
                p95: <strong className="text-amber-300">{(summary.p95Ms ?? 0).toFixed(1)} ms/frame</strong>
              </span>
              <span className="text-slate-600">•</span>
              <span>
                Hitches: <strong className={(summary.hitchCount ?? 0) > 0 ? 'text-rose-400' : 'text-slate-300'}>{summary.hitchCount ?? 0}</strong>
              </span>
            </div>
          ) : (
            <span className="font-semibold text-slate-300">Timeline &amp; Frame Graph</span>
          )}

          {/* Right: Scale Mode & View Controls */}
          <div className="flex items-center gap-2">
            {/* Thread Overlays */}
            <div className="flex items-center gap-2 text-[11px]">
              <label className="flex items-center gap-1 cursor-pointer hover:text-slate-200">
                <input
                  type="checkbox"
                  checked={showGame}
                  onChange={(e) => setShowGame(e.target.checked)}
                  className="rounded bg-slate-700 border-slate-600 text-emerald-500 focus:ring-0 w-3 h-3"
                />
                <span className="text-emerald-400">Game</span>
              </label>
              <label className="flex items-center gap-1 cursor-pointer hover:text-slate-200">
                <input
                  type="checkbox"
                  checked={showRender}
                  onChange={(e) => setShowRender(e.target.checked)}
                  className="rounded bg-slate-700 border-slate-600 text-purple-500 focus:ring-0 w-3 h-3"
                />
                <span className="text-purple-400">Render</span>
              </label>
              <label className="flex items-center gap-1 cursor-pointer hover:text-slate-200">
                <input
                  type="checkbox"
                  checked={showGpu}
                  onChange={(e) => setShowGpu(e.target.checked)}
                  className="rounded bg-slate-700 border-slate-600 text-orange-500 focus:ring-0 w-3 h-3"
                />
                <span className="text-orange-400">GPU</span>
              </label>
            </div>

            {/* Vertical Scale Mode Toggle */}
            <div className="flex items-center bg-slate-800/80 rounded border border-slate-700/80 p-0.5 text-[11px]">
              <button
                type="button"
                onClick={() => setScaleMode('p99')}
                title="Percentile Clamping: baseline resolution, capping off-scale spikes"
                className={`px-1.5 py-0.5 rounded transition-colors ${
                  scaleMode === 'p99'
                    ? 'bg-sky-600/70 text-sky-100 font-medium'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Auto (p99)
              </button>
              <button
                type="button"
                onClick={() => setScaleMode('fit')}
                title="Fit Peaks: scales vertical axis to fit highest hitch spike"
                className={`px-1.5 py-0.5 rounded transition-colors ${
                  scaleMode === 'fit'
                    ? 'bg-sky-600/70 text-sky-100 font-medium'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Fit Peaks
              </button>
            </div>

            <span className="text-slate-500 text-[11px] font-mono">
              {formatTime(viewRange[0])} – {formatTime(viewRange[1])}
            </span>
            <button
              type="button"
              onClick={handleResetZoom}
              className="px-2 py-0.5 rounded bg-slate-700/60 hover:bg-slate-700 text-slate-300 text-[11px] transition-colors"
            >
              Reset
            </button>
          </div>
        </div>

        {/* Bookmarks Bar: Up to 2 lines of bookmark chips + "+X more" expand toggle */}
        {bookmarks.length > 0 && (
          <div className="px-3 py-1.5 bg-slate-900/60 border-b border-slate-800 text-xs shrink-0">
            <BookmarkChipsList
              bookmarks={bookmarks}
              durationS={durationS}
              onSelectRange={onSelectRange}
            />
          </div>
        )}

        {/* Legend & Navigation Hint Bar - Included directly inside the frame graph container above the canvas */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 bg-slate-950/40 border-b border-slate-800/60 text-[11px] text-slate-400">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm bg-sky-400/80" />
              <span>Frame Time</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-0.5 border-b-2 border-sky-400 border-dashed" />
              <span>Target ({targetMs.toFixed(1)} ms)</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-sm bg-rose-500" />
              <span>Hitch Spike (#N)</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full bg-purple-500" />
              <span>Bookmark</span>
            </div>
            {showGame && (
              <div className="flex items-center gap-1 text-emerald-400">
                <span className="w-2 h-0.5 bg-emerald-400" />
                <span>Game</span>
              </div>
            )}
            {showRender && (
              <div className="flex items-center gap-1 text-purple-400">
                <span className="w-2 h-0.5 bg-purple-400" />
                <span>Render</span>
              </div>
            )}
            {showGpu && (
              <div className="flex items-center gap-1 text-orange-400">
                <span className="w-2 h-0.5 bg-orange-400" />
                <span>GPU</span>
              </div>
            )}
          </div>

          {/* Interaction Hint */}
          <div className="text-[11px] text-slate-400 font-mono">
            <strong className="text-slate-300">Drag</strong> = select • <strong className="text-slate-300">Wheel</strong> = zoom • <strong className="text-slate-300">Alt+Drag</strong> = pan
          </div>
        </div>

        {/* Canvas Viewport */}
        <div
          ref={containerRef}
          className="relative flex-1 w-full min-h-[180px] bg-slate-950/60 overflow-hidden cursor-crosshair select-none"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => {
            dragModeRef.current = 'none';
            setHoverInfo(null);
          }}
        >
          <canvas ref={canvasRef} className="absolute inset-0 block w-full h-full" />

        {/* Hover Tooltip */}
        {hoverInfo && (
          <div
            className="absolute z-10 pointer-events-none bg-slate-900/90 border border-slate-600 rounded px-2.5 py-1.5 text-xs text-slate-200 shadow-lg flex flex-col gap-0.5 backdrop-blur-sm"
            style={{
              left: `${Math.max(10, hoverInfo.x + 12)}px`,
              top: `${Math.max(10, hoverInfo.y - 45)}px`,
            }}
          >
            {hoverInfo.hitchNum !== undefined ? (
              <div>
                <span className="text-rose-400 font-bold">Hitch #{hoverInfo.hitchNum}</span>:{' '}
                <span className="font-mono text-amber-300 font-semibold">{hoverInfo.frameMs.toFixed(1)} ms</span>
                <div className="text-[11px] text-slate-400">At {formatTime(hoverInfo.timeS)} (Click to select)</div>
              </div>
            ) : hoverInfo.bookmarkName ? (
              <div>
                <span className="text-purple-300 font-semibold">📌 Bookmark:</span>{' '}
                <span className="font-mono text-purple-100">{hoverInfo.bookmarkName}</span>
                <div className="text-[11px] text-slate-400">At {formatTime(hoverInfo.timeS)} (Click to select)</div>
              </div>
            ) : (
              <>
                <div className="font-semibold text-sky-300">{formatTime(hoverInfo.timeS)}</div>
                <div>
                  {hoverInfo.minMs !== undefined && hoverInfo.maxMs !== undefined ? (
                    <span>
                      Avg: <span className="font-mono text-amber-300">{hoverInfo.frameMs.toFixed(1)} ms</span>{' '}
                      <span className="text-slate-400">({hoverInfo.minMs.toFixed(1)}–{hoverInfo.maxMs.toFixed(1)} ms)</span>
                    </span>
                  ) : (
                    <span>Frame: <span className="font-mono text-amber-300">{hoverInfo.frameMs.toFixed(1)} ms</span></span>
                  )}
                </div>
                {hoverInfo.gameMs !== undefined && <div className="text-emerald-400">Game: {hoverInfo.gameMs.toFixed(1)} ms</div>}
                {hoverInfo.renderMs !== undefined && <div className="text-purple-400">Render: {hoverInfo.renderMs.toFixed(1)} ms</div>}
                {hoverInfo.gpuMs !== undefined && <div className="text-orange-400">GPU: {hoverInfo.gpuMs.toFixed(1)} ms</div>}
              </>
            )}
          </div>
        )}
        </div>
      </div>

      {/* Findings Lane directly under the graph, aligned to same x-axis */}
      {(() => {
        if (!issues || issues.length === 0 || durationS <= 0) return null;

        // Group diagnoses by ruleId
        const map = new Map<
          string,
          {
            ruleId: string;
            totalExcessMs: number;
            occurrences: Array<{
              occurrence: Occurrence;
              issue: Issue;
            }>;
          }
        >();

        for (const item of issues) {
          const ruleId = item.issue.ruleId;
          let entry = map.get(ruleId);
          if (!entry) {
            entry = {
              ruleId,
              totalExcessMs: 0,
              occurrences: [],
            };
            map.set(ruleId, entry);
          }
          entry.totalExcessMs += item.issue.totalExcessMs;
          for (const occ of item.occurrences) {
            entry.occurrences.push({
              occurrence: occ,
              issue: item.issue,
            });
          }
        }

        const groupedDiagnoses = Array.from(map.values()).sort((a, b) => b.totalExcessMs - a.totalExcessMs);
        for (const group of groupedDiagnoses) {
          group.occurrences.sort((a, b) => a.occurrence.frameFrom - b.occurrence.frameFrom);
        }

        if (groupedDiagnoses.length === 0) return null;

        const displayedDiagnoses = showAllIssues ? groupedDiagnoses : groupedDiagnoses.slice(0, 6);

        return (
          <div className="flex flex-col gap-1.5 px-3 py-2 bg-slate-900/60 rounded border border-slate-800 text-xs">
            <div className="flex items-center justify-between text-[11px] text-slate-400 font-semibold mb-0.5">
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-sky-400" />
                <span className="text-slate-300">Findings Timeline Lane</span>
                <span className="text-slate-500 font-normal">
                  ({displayedDiagnoses.length} of {groupedDiagnoses.length} issues)
                </span>
              </span>

              {groupedDiagnoses.length > 6 && (
                <button
                  type="button"
                  onClick={() => setShowAllIssues(!showAllIssues)}
                  className="text-sky-400 hover:text-sky-300 font-medium text-[11px] transition-colors"
                >
                  {showAllIssues ? 'Show top 6' : `Show all (${groupedDiagnoses.length})`}
                </button>
              )}
            </div>

            <div className="flex flex-col gap-1.5 w-full">
              {displayedDiagnoses.map((diag) => {
                const color = RULE_COLORS[diag.ruleId] || '#38bdf8';
                const { label, badge, badgeColor } = getRuleDisplayLabel(diag.ruleId);

                return (
                  <div key={diag.ruleId} className="flex items-center gap-2 h-4 text-[10px]">
                    {/* Collapsed Diagnosis Label with Subsystem Badge */}
                    <div
                      className="w-48 flex items-center gap-1.5 shrink-0 overflow-hidden"
                      title={`${label} (${diag.ruleId}) • ${diag.occurrences.length} occurrence(s), total excess ${diag.totalExcessMs.toFixed(1)}ms`}
                    >
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
                      <span className={`px-1 py-0.2 rounded text-[8px] font-mono border shrink-0 ${badgeColor}`}>
                        {badge}
                      </span>
                      <span className="truncate text-slate-300 font-medium text-[10px]">
                        {label}
                      </span>
                    </div>

                    {/* Timeline Bar aligned to graph width (58px padLeft, 20px padRight) */}
                    <div className="flex-1 relative h-2.5 bg-slate-950/80 rounded overflow-hidden border border-slate-700/60">
                      {diag.occurrences.map((item) => {
                        const occ = item.occurrence;
                        const isSpike = item.issue.scale === 'spike';
                        const threadRole = item.issue.threadRole?.trim();
                        const occStart = occ.startS ?? 0;
                        const occEnd = occ.endS > occStart ? occ.endS : occStart + 0.016;
                        const leftPct = Math.max(0, Math.min(100, (occStart / durationS) * 100));
                        const widthPct = Math.max(0.4, Math.min(100 - leftPct, ((occEnd - occStart) / durationS) * 100));
                        const fromSec = occStart.toFixed(2);
                        const toSec = occEnd.toFixed(2);

                        return (
                          <div
                            key={occ.occurrenceId}
                            onClick={() => {
                              const oStart = Math.max(0, occStart - 0.2);
                              const oEnd = Math.min(durationS, occEnd + 0.2);
                              onSelectRange?.([oStart, oEnd]);
                            }}
                            className="absolute top-0 bottom-0 rounded-sm cursor-pointer hover:brightness-150 hover:scale-y-125 transition-all shadow-sm"
                            style={{
                              left: `${leftPct}%`,
                              width: `${widthPct}%`,
                              backgroundColor: color,
                              opacity: isSpike ? 1 : 0.85,
                            }}
                            title={`${label} [${item.issue.scale}] (${threadRole || 'all threads'})\n${fromSec}s – ${toSec}s\nPeak: ${occ.peakFrameMs.toFixed(1)} ms | Excess: +${occ.sumExcessMs.toFixed(1)} ms\nClick to select range`}
                          />
                        );
                      })}
                    </div>

                    {/* Summary Metric */}
                    <span className="text-[9px] text-slate-500 font-mono w-16 text-right shrink-0">
                      {diag.occurrences.length}x (+{diag.totalExcessMs.toFixed(0)}ms)
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
