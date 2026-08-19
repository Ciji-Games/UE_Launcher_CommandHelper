/**
 * Output Log panel - scrollable monospace log with colored lines.
 * Progress bar below the log with animated fill and elapsed time.
 *
 * Old launcher coloring:
 * - Green: Success, Completed
 * - Red: Error (also stderr)
 * - Orange: Warning
 * - Blue: Info
 * - White: Default
 */

import { useLayoutEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useLog } from '../contexts/LogContext';
import { useLogAnalyzerImportOptional } from '../contexts/LogAnalyzerImportContext';
import { useProgress } from '../contexts/ProgressContext';

export interface LogEvent {
  line: string;
  color?: 'green' | 'red' | 'orange' | 'blue' | 'white' | 'gray';
}

const colorClasses: Record<string, string> = {
  green: 'text-emerald-400',
  red: 'text-red-400',
  orange: 'text-amber-300',
  blue: 'text-sky-400',
  white: 'text-slate-200',
  gray: 'text-slate-500',
};

type LogType = 'message' | 'success' | 'warning' | 'error';

const colorToLogType: Record<string, LogType> = {
  green: 'success',
  red: 'error',
  orange: 'warning',
  blue: 'message',
  white: 'message',
  gray: 'message',
};

const LOG_TYPE_LABELS: { id: LogType; label: string }[] = [
  { id: 'message', label: 'Message' },
  { id: 'success', label: 'Success' },
  { id: 'warning', label: 'Warning' },
  { id: 'error', label: 'Error' },
];

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function StopIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden
    >
      <rect x="6" y="6" width="12" height="12" rx="1" />
    </svg>
  );
}

const SCROLL_THRESHOLD = 24;

export function OutputLogPanel() {
  const { lines, appendLine, clearLog } = useLog();
  const logAnalyzerImport = useLogAnalyzerImportOptional();
  const { running, percent, elapsedMs, stepProgress, finishProgress, requestStop } = useProgress();
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);
  const [stopping, setStopping] = useState(false);
  const [filters, setFilters] = useState<Record<LogType, boolean>>({
    message: true,
    success: true,
    warning: true,
    error: true,
  });

  const filteredLines = lines.filter((entry) => {
    const type = colorToLogType[entry.color ?? 'white'] ?? 'message';
    return filters[type];
  });


  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    isAtBottomRef.current = distanceFromBottom <= SCROLL_THRESHOLD;
  };

  // Only auto-scroll when user is at bottom; otherwise let them read history
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && isAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [lines]);

  const handleClear = () => {
    isAtBottomRef.current = true;
    clearLog();
  };

  const handleSendToVisualizer = () => {
    const text = lines.map((e) => e.line).join('\n');
    logAnalyzerImport?.sendToVisualizer(text, 'output-log.txt');
  };

  const handleCopy = async () => {
    const text = filteredLines.map((e) => e.line).join('\n');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement('textarea');
      textarea.value = text;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
  };

  const handleStop = async () => {
    if (!running || stopping) return;
    setStopping(true);
    requestStop();
    try {
      await invoke('stop_running_process');
      finishProgress();
    } catch (e) {
      const msg = typeof e === 'string' ? e : (e as Error)?.message ?? 'Failed to stop';
      appendLine({ line: msg, color: 'red' });
    } finally {
      setStopping(false);
    }
  };

  const toggleFilter = (type: LogType) => {
    setFilters((prev) => ({ ...prev, [type]: !prev[type] }));
  };

  return (
    <div className="flex flex-col gap-2 min-h-0 flex-1">
      <div className="flex flex-wrap items-center justify-between gap-3 shrink-0">
        <div className="flex flex-wrap items-center gap-3">
          {LOG_TYPE_LABELS.map(({ id, label }) => (
            <label
              key={id}
              className="flex items-center gap-1.5 cursor-pointer text-sm text-slate-400 hover:text-slate-300 transition-colors"
            >
              <input
                type="checkbox"
                checked={filters[id]}
                onChange={() => toggleFilter(id)}
                className="rounded border-slate-600 bg-slate-700 text-sky-500 focus:ring-sky-500/50 focus:ring-offset-0"
              />
              <span>{label}</span>
            </label>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleCopy}
            className="rounded-md px-3 py-1 text-sm bg-slate-700/60 text-slate-300 hover:bg-slate-600/60 hover:text-slate-100 transition-colors"
          >
            Copy
          </button>
          <button
            type="button"
            onClick={handleClear}
            className="rounded-md px-3 py-1 text-sm bg-slate-700/60 text-slate-300 hover:bg-slate-600/60 hover:text-slate-100 transition-colors"
          >
            Clear
          </button>
          {logAnalyzerImport && (
            <button
              type="button"
              onClick={handleSendToVisualizer}
              disabled={lines.length === 0}
              className="rounded-md px-3 py-1 text-sm bg-sky-700/50 text-sky-100 hover:bg-sky-600/60 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              title="Open UE Log Analyzer with the full output log"
            >
              Send to Analyzer
            </button>
          )}
        </div>
      </div>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 min-h-0 overflow-y-auto rounded-lg bg-slate-900/50 p-3 font-mono text-sm leading-relaxed border border-slate-700/50"
      >
        {filteredLines.length === 0 ? (
          <p className="text-slate-500 italic">
            {lines.length === 0
              ? 'Log output will appear here...'
              : 'No messages match the current filters.'}
          </p>
        ) : (
          filteredLines.map((entry, i) => (
            <div
              key={i}
              className={colorClasses[entry.color ?? 'white'] ?? 'text-slate-200'}
            >
              {entry.line}
            </div>
          ))
        )}
      </div>
      {running && (
        <div className="flex flex-col gap-2 shrink-0 -mt-0.5">
          {stepProgress && stepProgress.totalSteps > 1 ? (
            <div className="flex items-center gap-2">
              <div className="flex gap-2 flex-wrap flex-1 min-w-0">
                {stepProgress.stepPercents.map((pct, i) => (
                  <div
                    key={i}
                    className={`flex-1 min-w-[4rem] flex flex-col gap-0.5 ${
                      i === stepProgress.currentStep
                        ? 'ring-1 ring-sky-500/50 rounded px-2 py-1 -m-px'
                        : ''
                    }`}
                  >
                    <span
                      className={`text-xs truncate block ${
                        i === stepProgress.currentStep
                          ? 'text-sky-200 font-medium'
                          : 'text-slate-500'
                      }`}
                      title={stepProgress.stepLabels[i]}
                    >
                      {stepProgress.stepLabels[i] ?? `Step ${i + 1}`}
                    </span>
                    <div className="h-2.5 rounded-full bg-slate-800 overflow-hidden">
                      <div
                        className={`h-full transition-all duration-300 ${
                          i < stepProgress.currentStep
                            ? 'bg-emerald-500'
                            : i === stepProgress.currentStep
                              ? 'bg-sky-500 progress-bar-fill'
                              : 'bg-slate-700'
                        }`}
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
              <span className="text-sm text-slate-400 tabular-nums shrink-0">
                {formatElapsed(elapsedMs)}
              </span>
              <button
                type="button"
                onClick={handleStop}
                disabled={stopping}
                className="rounded p-1.5 text-red-400 hover:bg-red-500/20 hover:text-red-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
                title="Terminates the running process (taskkill /F /PID)."
                aria-label="Stop process"
              >
                <StopIcon className="w-4 h-4" />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-3">
              <div className="flex-1 h-3.5 rounded-full bg-slate-800 overflow-hidden">
                <div
                  className="h-full bg-sky-500 transition-all duration-300 relative overflow-hidden progress-bar-fill"
                  style={{
                    width: `${percent}%`,
                  }}
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-slate-400 tabular-nums min-w-[3rem]">
                  {formatElapsed(elapsedMs)}
                </span>
                <button
                  type="button"
                  onClick={handleStop}
                  disabled={stopping}
                  className="rounded p-1.5 text-red-400 hover:bg-red-500/20 hover:text-red-300 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  title="Terminates the running process (taskkill /F /PID)."
                  aria-label="Stop process"
                >
                  <StopIcon className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
