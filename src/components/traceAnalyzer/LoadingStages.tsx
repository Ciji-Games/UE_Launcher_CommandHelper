import type { ImportProgressPayload, TraceProgressPayload, TraceStage } from '../../types/traceAnalyzer';

interface LoadingStagesProps {
  progress: TraceProgressPayload | null;
  importProgress?: ImportProgressPayload | null;
  onCancel: () => void;
}

const V3_IMPORT_STAGES = [
  { id: 'pass_a', label: '1. Pass A: Threads, Timers & Frame Boundaries' },
  { id: 'slices', label: '2. Full Timer Ingestion & Exclusive Sums' },
  { id: 'baseline', label: '3. Global Normal Baseline Calculation' },
  { id: 'summaries', label: '4. 2-Level Block Summary Pyramid (64 & 4096f)' },
];

const GAME_TRACE_STAGES: { id: TraceStage; label: string }[] = [
  { id: 'launching_game', label: '1. Launching Game Executable' },
  { id: 'monitoring_game', label: '2. Monitoring Game & Tracing' },
  { id: 'locating_insights', label: '3. Locating Unreal Insights' },
  { id: 'exporting_frames', label: '4. Pass A: Exporting Frame Boundaries' },
  { id: 'ingesting_frames', label: '5. Streaming Frame Timeline' },
  { id: 'ingesting_windows', label: '6. Streaming Timer Slices & Pyramid' },
  { id: 'analyzing', label: '7. Matching Diagnosis Catalog' },
];

export function LoadingStages({ progress, importProgress, onCancel }: LoadingStagesProps) {
  const currentStage = progress?.stage || 'locating_insights';
  const isGameMode = currentStage === 'launching_game' || currentStage === 'monitoring_game';

  const elapsedSec = ((importProgress?.elapsedMs || progress?.elapsedMs || 0) / 1000).toFixed(1);
  const remainingSec = importProgress?.estimatedRemainingMs
    ? `${(importProgress.estimatedRemainingMs / 1000).toFixed(0)}s remaining`
    : null;

  const currentImportStageId = importProgress?.stage || (currentStage === 'exporting_frames' || currentStage === 'ingesting_frames' ? 'pass_a' : 'slices');
  const importStageIdx = V3_IMPORT_STAGES.findIndex((s) => s.id === currentImportStageId);

  return (
    <div className="flex flex-col items-center justify-center p-8 max-w-lg mx-auto w-full bg-slate-800/40 border border-slate-700/60 rounded-xl gap-5 backdrop-blur-sm">
      <div className="flex items-center justify-between w-full">
        <div className="flex items-center gap-2.5">
          <svg className="animate-spin h-5 w-5 text-sky-400" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
          <span className="text-sm font-semibold text-slate-100">
            {isGameMode ? 'Running & Profiling Game...' : 'Importing & Indexing Trace...'}
          </span>
        </div>

        <div className="flex items-center gap-2 font-mono text-xs text-slate-400">
          <span>{elapsedSec}s elapsed</span>
          {remainingSec && <span className="text-sky-400 font-medium">({remainingSec})</span>}
        </div>
      </div>

      {/* Progress Bar */}
      <div className="w-full bg-slate-700/50 rounded-full h-2 overflow-hidden border border-slate-600/40">
        <div
          className="bg-sky-500 h-2 rounded-full transition-all duration-300 relative overflow-hidden"
          style={{
            width: importProgress?.totalSlices && importProgress.totalSlices > 0 && importProgress.stage === 'slices'
              ? `${Math.max(15, (importProgress.currentSlice / importProgress.totalSlices) * 70)}%`
              : `${Math.max(10, ((Math.max(0, importStageIdx) + 1) / V3_IMPORT_STAGES.length) * 100)}%`,
          }}
        >
          <div className="absolute inset-0 bg-white/20 animate-pulse" />
        </div>
      </div>

      {/* Stage Breakdown */}
      <div className="flex flex-col gap-2 w-full text-xs">
        {isGameMode ? (
          GAME_TRACE_STAGES.map((s, idx) => {
            const isDone = GAME_TRACE_STAGES.findIndex((st) => st.id === currentStage) > idx;
            const isCurrent = currentStage === s.id;
            return (
              <div
                key={s.id}
                className={`flex items-center justify-between px-3 py-1.5 rounded transition-colors ${
                  isCurrent
                    ? 'bg-sky-950/40 text-sky-200 border border-sky-800/50 font-medium'
                    : isDone
                    ? 'text-slate-400'
                    : 'text-slate-600'
                }`}
              >
                <span>{s.label}</span>
                {isDone ? (
                  <span className="text-emerald-400 font-bold">✓</span>
                ) : isCurrent ? (
                  <span className="text-sky-400 animate-pulse font-semibold">
                    {s.id === 'monitoring_game' ? 'Running' : 'In Progress'}
                  </span>
                ) : (
                  <span>•</span>
                )}
              </div>
            );
          })
        ) : (
          V3_IMPORT_STAGES.map((s, idx) => {
            const isDone = importStageIdx > idx;
            const isCurrent = importStageIdx === idx;
            const sliceDetail =
              s.id === 'slices' && isCurrent && importProgress?.totalSlices
                ? `(Slice ${importProgress.currentSlice}/${importProgress.totalSlices})`
                : null;

            return (
              <div
                key={s.id}
                className={`flex items-center justify-between px-3 py-1.5 rounded transition-colors ${
                  isCurrent
                    ? 'bg-sky-950/40 text-sky-200 border border-sky-800/50 font-medium'
                    : isDone
                    ? 'text-slate-400'
                    : 'text-slate-600'
                }`}
              >
                <span className="flex items-center gap-1.5">
                  {s.label}
                  {sliceDetail && <span className="text-sky-400 font-mono text-[10px]">{sliceDetail}</span>}
                </span>
                {isDone ? (
                  <span className="text-emerald-400 font-bold">✓</span>
                ) : isCurrent ? (
                  <span className="text-sky-400 animate-pulse font-semibold">In Progress</span>
                ) : (
                  <span>•</span>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Status Message */}
      {(importProgress?.message || progress?.message) && (
        <p className="text-xs text-slate-400 text-center italic">
          {importProgress?.message || progress?.message}
        </p>
      )}

      {/* Stop / Cancel Button */}
      <button
        type="button"
        onClick={onCancel}
        className="px-4 py-1.5 bg-rose-900/40 hover:bg-rose-800/60 text-rose-200 border border-rose-700/50 rounded text-xs font-medium transition-colors"
      >
        {isGameMode ? 'Stop Game & Cancel' : 'Cancel Analysis'}
      </button>
    </div>
  );
}
