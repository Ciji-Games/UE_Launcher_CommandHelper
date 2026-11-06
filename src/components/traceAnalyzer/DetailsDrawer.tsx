import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { CacheInfo, TraceSummary } from '../../types/traceAnalyzer';

interface DetailsDrawerProps {
  summary: TraceSummary | null;
  onRefreshDiagnostic?: () => void;
  onCleanAllCaches?: () => void;
}

export function DetailsDrawer({ summary, onRefreshDiagnostic, onCleanAllCaches }: DetailsDrawerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [cacheInfo, setCacheInfo] = useState<CacheInfo | null>(null);

  useEffect(() => {
    if (isOpen && !cacheInfo) {
      invoke<CacheInfo>('trace_cache_info')
        .then(setCacheInfo)
        .catch((e) => console.error('Failed to fetch cache info:', e));
    }
  }, [isOpen, cacheInfo]);

  if (!summary) return null;

  return (
    <div className="mt-2 border-t border-slate-800 pt-2 shrink-0">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-between w-full p-2.5 rounded-lg bg-slate-900/60 hover:bg-slate-900 text-xs text-slate-400 hover:text-slate-200 border border-slate-800 transition-colors"
      >
        <div className="flex items-center gap-2 font-medium">
          <svg
            className={`w-4 h-4 transition-transform duration-200 ${isOpen ? 'rotate-90' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <span>Trace Details &amp; Engine Metadata</span>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-slate-500">
          <span>{summary.detectedChannels?.length || 0} channels active</span>
          {summary.isEditorBuild && <span className="text-amber-400/80">• Editor Session</span>}
        </div>
      </button>

      {isOpen && (
        <div className="flex flex-col gap-3 p-3.5 mt-1.5 rounded-lg bg-slate-950/70 border border-slate-800 text-xs">
          {/* Channels Section */}
          <div className="flex flex-col gap-1.5">
            <span className="font-semibold text-slate-300 uppercase tracking-wider text-[11px]">
              Captured Engine Channels
            </span>
            <div className="flex flex-wrap gap-1.5">
              {summary.detectedChannels?.map((ch) => (
                <span
                  key={ch}
                  className="px-2 py-0.5 rounded bg-emerald-950/60 text-emerald-300 border border-emerald-500/30 text-[11px] font-mono"
                >
                  ✓ {ch}
                </span>
              ))}
              {summary.missingChannels?.map((ch) => (
                <span
                  key={ch}
                  className="px-2 py-0.5 rounded bg-slate-900 text-slate-500 border border-slate-800 text-[11px] font-mono"
                >
                  ✕ {ch} (missing)
                </span>
              ))}
            </div>
          </div>

          {/* Editor Note */}
          {summary.isEditorBuild && (
            <div className="p-2.5 rounded bg-amber-950/30 border border-amber-600/30 text-amber-200/90 text-xs leading-relaxed">
              <strong>Editor Capture Notice:</strong> This trace was recorded inside an active Unreal Editor session (`UEditorEngine::Tick`).
              Slate UI rendering, asset editor viewports, and background editor compilation tasks contribute to frame time overhead.
            </div>
          )}

          {/* Cache & File Info */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800/60 text-[11px] text-slate-400">
            <div>
              Trace Path: <code className="text-slate-300 bg-slate-900 px-1 py-0.5 rounded font-mono">{summary.path || 'Unknown'}</code>
            </div>
            <div className="flex items-center gap-3">
              {cacheInfo && (
                <div>
                  Cache: <span className="font-mono text-slate-300">{cacheInfo.totalFiles} files</span> ({((cacheInfo.totalSizeBytes || 0) / 1024 / 1024).toFixed(1)} MB)
                </div>
              )}
              {onRefreshDiagnostic && (
                <button
                  type="button"
                  onClick={onRefreshDiagnostic}
                  className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-[11px] transition-colors"
                  title="Clear cache and re-import this trace"
                >
                  Re-import Trace
                </button>
              )}
              {onCleanAllCaches && (
                <button
                  type="button"
                  onClick={onCleanAllCaches}
                  className="px-2 py-0.5 rounded bg-slate-800 hover:bg-rose-950/60 hover:text-rose-200 hover:border-rose-700/60 text-slate-300 border border-slate-700 text-[11px] transition-colors"
                  title="Clear all cached trace databases"
                >
                  Clean All DB Caches
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
