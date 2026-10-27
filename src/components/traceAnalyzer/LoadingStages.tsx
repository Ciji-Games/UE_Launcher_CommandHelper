import type { TraceProgressPayload, TraceStage } from '../../types/traceAnalyzer';

interface LoadingStagesProps {
  progress: TraceProgressPayload | null;
  onCancel: () => void;
}

const TRACE_STAGES: { id: TraceStage; label: string }[] = [
  { id: 'locating_insights', label: '1. Locating Unreal Insights' },
  { id: 'exporting_frames', label: '2. Pass A: Exporting Frame Boundaries' },
  { id: 'ingesting_frames', label: '3. Streaming Frame Timeline' },
  { id: 'detecting_episodes', label: '4. Detecting Hitches & Slow Regions' },
  { id: 'exporting_windows', label: '5. Pass B: Targeted Window Export' },
  { id: 'ingesting_windows', label: '6. Computing Exclusive Times' },
  { id: 'analyzing', label: '7. Matching Diagnosis Catalog' },
];

const GAME_TRACE_STAGES: { id: TraceStage; label: string }[] = [
  { id: 'launching_game', label: '1. Launching Game Executable' },
  { id: 'monitoring_game', label: '2. Monitoring Game & Tracing' },
  { id: 'locating_insights', label: '3. Locating Unreal Insights' },
  { id: 'exporting_frames', label: '4. Pass A: Exporting Frame Boundaries' },
  { id: 'ingesting_frames', label: '5. Streaming Frame Timeline' },
  { id: 'detecting_episodes', label: '6. Detecting Hitches & Slow Regions' },
  { id: 'exporting_windows', label: '7. Pass B: Targeted Window Export' },
  { id: 'ingesting_windows', label: '8. Computing Exclusive Times' },
  { id: 'analyzing', label: '9. Matching Diagnosis Catalog' },
];

export function LoadingStages({ progress, onCancel }: LoadingStagesProps) {
  const currentStage = progress?.stage || 'locating_insights';
  const isGameMode = currentStage === 'launching_game' || currentStage === 'monitoring_game';
  const stages = isGameMode ? GAME_TRACE_STAGES : TRACE_STAGES;
  const stageIndex = stages.findIndex((s) => s.id === currentStage);

  const elapsedSec = ((progress?.elapsedMs || 0) / 1000).toFixed(1);

  return (
    <div className="flex flex-col items-center justify-center p-8 max-w-lg mx-auto w-full bg-slate-800/40 border border-slate-700/60 rounded-xl gap-5 backdrop-blur-sm">
      <div className="flex items-center justify-between w-full">
        <div className="flex items-center gap-2.5">
          <svg className="animate-spin h-5 w-5 text-sky-400" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
          </svg>
          <span className="text-sm font-semibold text-slate-100">
            {isGameMode ? 'Running & Profiling Game...' : 'Analyzing Performance Capture...'}
          </span>
        </div>

        <span className="font-mono text-xs text-slate-400">{elapsedSec}s elapsed</span>
      </div>

      {/* Progress Bar */}
      <div className="w-full bg-slate-700/50 rounded-full h-2 overflow-hidden border border-slate-600/40">
        <div
          className="bg-sky-500 h-2 rounded-full transition-all duration-300 relative overflow-hidden"
          style={{ width: `${Math.max(10, ((Math.max(0, stageIndex) + 1) / stages.length) * 100)}%` }}
        >
          <div className="absolute inset-0 bg-white/20 animate-pulse" />
        </div>
      </div>

      {/* Stage Breakdown */}
      <div className="flex flex-col gap-2 w-full text-xs">
        {stages.map((s, idx) => {
          const isDone = stageIndex > idx;
          const isCurrent = stageIndex === idx;

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
        })}
      </div>

      {/* Status Message */}
      {progress?.message && (
        <p className="text-xs text-slate-400 text-center italic">{progress.message}</p>
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
