import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Episode, FrameSeriesResponse } from '../../types/traceAnalyzer';

interface FrameGraphProps {
  durationS: number;
  targetMs: number;
  episodes: Episode[];
  selectedEpisodeId: number | null;
  onSelectEpisode: (id: number | null) => void;
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

export function FrameGraph({
  durationS,
  targetMs,
  episodes,
  selectedEpisodeId,
  onSelectEpisode,
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
  } | null>(null);

  // Drag / pan state
  const isDraggingRef = useRef(false);
  const dragStartXRef = useRef(0);
  const dragStartRangeRef = useRef<[number, number]>([0, 1]);

  // Selection range (shift + drag)
  const [selectionRange, setSelectionRange] = useState<[number, number] | null>(null);
  const isSelectingRef = useRef(false);
  const selectStartXRef = useRef(0);

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

    // Padding
    const padL = 45;
    const padR = 20;
    const padT = 20;
    const padB = 25;

    const graphW = width - padL - padR;
    const graphH = height - padT - padB;

    // Determine max Y scale (ms)
    // We use p99.5 auto-scaling by default so rare multi-second hitches do not crush 99% of normal frames.
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
          // p99.5 auto-scaling gives high vertical resolution to normal frames
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
        ctx.fillText(b.label, padL - 6, y + 3);
      }
    }
    ctx.setLineDash([]);

    // Draw Slow Region shaded bands
    for (const ep of episodes) {
      if (ep.kind === 'slow_region') {
        const x1 = Math.max(timeToX(ep.startS), padL);
        const x2 = Math.min(timeToX(ep.endS), padL + graphW);
        if (x2 > x1) {
          ctx.fillStyle = ep.id === selectedEpisodeId ? 'rgba(245, 158, 11, 0.25)' : 'rgba(245, 158, 11, 0.12)';
          ctx.fillRect(x1, padT, x2 - x1, graphH);
        }
      }
    }

    // Draw Frame Series (Buckets or Individual Points)
    if (seriesData) {
      if (seriesData.isBucketed && seriesData.buckets.length > 0) {
        // Draw min-max bars and average line
        for (const b of seriesData.buckets) {
          const x1 = timeToX(b.t0);
          const x2 = timeToX(b.t1);
          const barW = Math.max(x2 - x1, 1);
          const isOffScale = b.maxMs > maxY;

          const yMin = msToY(b.minMs);
          const yMax = msToY(b.maxMs);
          const yAvg = msToY(b.avgMs);

          // Color based on avgMs vs target
          let barColor = 'rgba(56, 189, 248, 0.75)'; // sky
          let maxRangeColor = 'rgba(56, 189, 248, 0.25)';
          if (b.avgMs >= targetMs * 2) {
            barColor = 'rgba(239, 68, 68, 0.85)'; // red
            maxRangeColor = 'rgba(239, 68, 68, 0.35)';
          } else if (b.avgMs >= targetMs * 1.25) {
            barColor = 'rgba(245, 158, 11, 0.8)'; // amber
            maxRangeColor = 'rgba(245, 158, 11, 0.3)';
          }

          // 1. Min-max range bar (lighter background)
          ctx.fillStyle = maxRangeColor;
          ctx.fillRect(x1, yMax, barW, Math.max(baseBottomY - yMax, 1));

          // 2. Average body bar from bottom up to yAvg
          ctx.fillStyle = barColor;
          ctx.fillRect(x1, yAvg, barW, Math.max(baseBottomY - yAvg, 1));

          // 3. Top peak indicator or off-scale chevron cap
          if (isOffScale) {
            ctx.fillStyle = '#ef4444'; // Red cap for off-scale hitch
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
        // Individual frame bars
        const points = seriesData.points;
        const ptWidth = Math.max(graphW / Math.max(points.length, 1), 1.5);

        for (const p of points) {
          const x = timeToX(p.t);
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
          ctx.fillRect(x - ptWidth / 2, y, ptWidth, barH);

          if (isOffScale) {
            ctx.fillStyle = '#ef4444';
            ctx.fillRect(x - ptWidth / 2, padT, ptWidth, 2.5);
            ctx.fillStyle = '#fca5a5';
            ctx.font = 'bold 8px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('▲', x, padT - 2);
          }

          // Optional sub-stages
          if (showGame && p.gameMs) {
            const gy = msToY(p.gameMs);
            ctx.fillStyle = '#34d399'; // emerald
            ctx.fillRect(x - ptWidth / 2, gy, ptWidth, 2);
          }
          if (showRender && p.renderMs) {
            const ry = msToY(p.renderMs);
            ctx.fillStyle = '#a78bfa'; // purple
            ctx.fillRect(x - ptWidth / 2, ry, ptWidth, 2);
          }
          if (showGpu && p.gpuMs) {
            const py = msToY(p.gpuMs);
            ctx.fillStyle = '#fb923c'; // orange
            ctx.fillRect(x - ptWidth / 2, py, ptWidth, 2);
          }
        }
      }
    }

    // Draw Hitch Markers
    for (const ep of episodes) {
      if (ep.kind === 'hitch') {
        const x = timeToX(ep.startS);
        if (x >= padL && x <= padL + graphW) {
          const y = msToY(ep.peakMs) - 6;
          const isSel = ep.id === selectedEpisodeId;

          ctx.fillStyle = isSel ? '#fbbf24' : '#ef4444';
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(x - 4, y - 7);
          ctx.lineTo(x + 4, y - 7);
          ctx.closePath();
          ctx.fill();

          if (isSel) {
            ctx.strokeStyle = '#fbbf24';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.moveTo(x, padT);
            ctx.lineTo(x, padT + graphH);
            ctx.stroke();
          }
        }
      }
    }

    // Draw selection overlay
    if (selectionRange) {
      const [s0, s1] = selectionRange;
      const sx1 = Math.max(timeToX(Math.min(s0, s1)), padL);
      const sx2 = Math.min(timeToX(Math.max(s0, s1)), padL + graphW);
      if (sx2 > sx1) {
        ctx.fillStyle = 'rgba(56, 189, 248, 0.2)';
        ctx.fillRect(sx1, padT, sx2 - sx1, graphH);
        ctx.strokeStyle = '#38bdf8';
        ctx.strokeRect(sx1, padT, sx2 - sx1, graphH);
      }
    }

    // Draw X-axis time labels
    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    const labelSteps = 5;
    for (let i = 0; i <= labelSteps; i++) {
      const t = vStart + (i / labelSteps) * vDuration;
      const x = timeToX(t);
      ctx.fillText(formatTime(t), x, padT + graphH + 16);
    }

    // Frame axis line
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, padT + graphH);
    ctx.lineTo(padL + graphW, padT + graphH);
    ctx.stroke();

    ctx.restore();
  }, [viewRange, seriesData, targetMs, episodes, selectedEpisodeId, selectionRange, showGame, showRender, showGpu, scaleMode]);

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

  // Mouse wheel zoom (native non-passive event listener)
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onNativeWheel = (e: WheelEvent) => {
      e.preventDefault();
      const canvas = canvasRef.current;
      if (!canvas) return;

      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left - 45;
      const graphW = rect.width - 65;
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

  // Mouse down: drag pan or shift selection
  const handleMouseDown = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;

    if (e.shiftKey) {
      isSelectingRef.current = true;
      selectStartXRef.current = x;
      const t = pixelToTime(x, rect.width);
      setSelectionRange([t, t]);
    } else {
      isDraggingRef.current = true;
      dragStartXRef.current = e.clientX;
      dragStartRangeRef.current = [...viewRange];
    }
  };

  const pixelToTime = (px: number, totalW: number) => {
    const padL = 45;
    const padR = 20;
    const graphW = totalW - padL - padR;
    const ratio = Math.max(0, Math.min(1, (px - padL) / graphW));
    const [vStart, vEnd] = viewRange;
    return vStart + ratio * (vEnd - vStart);
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;

    if (isSelectingRef.current) {
      const t0 = pixelToTime(selectStartXRef.current, rect.width);
      const t1 = pixelToTime(x, rect.width);
      setSelectionRange([t0, t1]);
    } else if (isDraggingRef.current) {
      const deltaPx = e.clientX - dragStartXRef.current;
      const graphW = rect.width - 65;
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
      // Hover tooltip info
      const t = pixelToTime(x, rect.width);
      if (seriesData && !seriesData.isBucketed) {
        const hoveredPoint = seriesData.points.find((p) => Math.abs(p.t - t) < 0.05);
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
        const bucket = seriesData.buckets.find((b) => t >= b.t0 && t <= b.t1);
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
    if (isSelectingRef.current) {
      isSelectingRef.current = false;
    }
    if (isDraggingRef.current) {
      isDraggingRef.current = false;
    }

    // Click to select episode
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const t = pixelToTime(x, rect.width);

    const hitEpisode = episodes.find((ep) => t >= ep.startS - 0.05 && t <= ep.endS + 0.05);
    if (hitEpisode) {
      onSelectEpisode(hitEpisode.id);
    }
  };

  const handleResetZoom = () => {
    setViewRange([0, Math.max(durationS, 1)]);
    setSelectionRange(null);
  };

  return (
    <div className="flex flex-col gap-2 w-full h-full min-h-[220px]">
      {/* Graph Toolbar */}
      <div className="flex items-center justify-between px-2 text-xs text-slate-400">
        <div className="flex items-center gap-3">
          <span className="font-medium text-slate-300">Frame Time Graph</span>
          <label className="flex items-center gap-1.5 cursor-pointer hover:text-slate-200">
            <input
              type="checkbox"
              checked={showGame}
              onChange={(e) => setShowGame(e.target.checked)}
              className="rounded bg-slate-700 border-slate-600 text-emerald-500 focus:ring-0"
            />
            <span className="text-emerald-400">Game</span>
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer hover:text-slate-200">
            <input
              type="checkbox"
              checked={showRender}
              onChange={(e) => setShowRender(e.target.checked)}
              className="rounded bg-slate-700 border-slate-600 text-purple-500 focus:ring-0"
            />
            <span className="text-purple-400">Render</span>
          </label>
          <label className="flex items-center gap-1.5 cursor-pointer hover:text-slate-200">
            <input
              type="checkbox"
              checked={showGpu}
              onChange={(e) => setShowGpu(e.target.checked)}
              className="rounded bg-slate-700 border-slate-600 text-orange-500 focus:ring-0"
            />
            <span className="text-orange-400">GPU</span>
          </label>
        </div>

        <div className="flex items-center gap-2">
          {/* Vertical Scale Mode Toggle */}
          <div className="flex items-center bg-slate-800/80 rounded border border-slate-700/80 p-0.5 text-[11px]">
            <button
              type="button"
              onClick={() => setScaleMode('p99')}
              title="Percentile Clamping: prioritizes frame-to-frame baseline resolution, capping off-scale spikes"
              className={`px-2 py-0.5 rounded transition-colors ${
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
              title="Fit Peaks: scales vertical axis to fit the absolute highest hitch spike"
              className={`px-2 py-0.5 rounded transition-colors ${
                scaleMode === 'fit'
                  ? 'bg-sky-600/70 text-sky-100 font-medium'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Fit Peaks
            </button>
          </div>

          <span className="text-slate-500">
            Range: {formatTime(viewRange[0])} – {formatTime(viewRange[1])}
          </span>
          <button
            type="button"
            onClick={handleResetZoom}
            className="px-2 py-0.5 rounded bg-slate-700/60 hover:bg-slate-700 text-slate-300 transition-colors"
          >
            Reset View
          </button>
        </div>
      </div>

      {/* Canvas Viewport */}
      <div
        ref={containerRef}
        className="relative flex-1 w-full min-h-[170px] bg-slate-900/60 rounded border border-slate-700/60 overflow-hidden cursor-crosshair"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={() => {
          isDraggingRef.current = false;
          isSelectingRef.current = false;
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
          </div>
        )}
      </div>
    </div>
  );
}
