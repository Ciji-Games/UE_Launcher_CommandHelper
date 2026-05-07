/**
 * ToolBox tab - vertical menu + content panel, Output Log.
 * Step 10: Two-column layout with ToolGroup panels. Step 11: UmapHelper.
 */

import { useState, useEffect } from 'react';
import { useProgress } from '../contexts/ProgressContext';
import { RegenerateProjectPanel } from './RegenerateProjectPanel';
import { UmapHelperPanel } from './UmapHelperPanel';
import { ShaderBoosterPanel } from './ShaderBoosterPanel';
import { PluginHelperPanel } from './PluginHelperPanel';
import { UProjectHelperPanel } from './UProjectHelperPanel';
import { MovieRenderQueuePanel } from './MovieRenderQueuePanel';
import { BatchCommitPanel } from './BatchCommitPanel';
import { OutputLogPanel } from './OutputLogPanel';
import { UELogAnalyzerPanel } from './UELogAnalyzerPanel';

const TOOLS = [
  { id: 'shader', label: 'Shader Booster', panel: ShaderBoosterPanel, contentOverflow: 'auto' },
  { id: 'regenerate', label: 'Regenerate Project', panel: RegenerateProjectPanel, contentOverflow: 'auto' },
  { id: 'batchcommit', label: 'Batch Commit', panel: BatchCommitPanel, contentOverflow: 'auto' },
  { id: 'umap', label: 'UMap Helper', panel: UmapHelperPanel, contentOverflow: 'auto' },
  { id: 'plugin', label: 'Plugin Helper', panel: PluginHelperPanel, contentOverflow: 'auto' },
  { id: 'uproject', label: 'UProject Helper', panel: UProjectHelperPanel, contentOverflow: 'auto' },
  { id: 'movierenderqueue', label: 'Movie Render Queue', panel: MovieRenderQueuePanel, contentOverflow: 'auto' },
  { id: 'log-analyzer', label: 'UE Log Analyzer', panel: UELogAnalyzerPanel, contentOverflow: 'hidden' },
] as const;

type ToolId = (typeof TOOLS)[number]['id'];

export function ToolBoxTab() {
  const [selectedToolId, setSelectedToolId] = useState<ToolId>(TOOLS[0].id);
  const [showOutputLog, setShowOutputLog] = useState(false);
  const { running, shouldOpenOutputLog } = useProgress();

  const selectedTool = TOOLS.find((t) => t.id === selectedToolId);
  const SelectedPanel = selectedTool?.panel ?? RegenerateProjectPanel;
  const contentOverflow = selectedTool?.contentOverflow ?? 'auto';

  useEffect(() => {
    if (running && shouldOpenOutputLog) setShowOutputLog(true);
  }, [running, shouldOpenOutputLog]);

  return (
    <div className="flex flex-col gap-6 flex-1 min-h-0">
      {/* Tool area - fixed 60% of vertical space for stable layout when switching tools */}
      <div
        className={`flex gap-4 min-h-0 overflow-hidden transition-all flex-1 ${
          showOutputLog ? 'flex-[6_1_0]' : 'flex-[1_1_0]'
        }`}
      >
        {/* Left: Vertical menu */}
        <div className="w-44 shrink-0 flex flex-col">
          <nav className="flex flex-col gap-px rounded-lg overflow-hidden bg-slate-800/50 border border-slate-600/60">
            {TOOLS.map((tool) => (
              <button
                key={tool.id}
                type="button"
                onClick={() => setSelectedToolId(tool.id)}
                className={`px-4 py-2.5 text-left text-sm font-medium transition-colors first:rounded-t-lg last:rounded-b-lg ${
                  selectedToolId === tool.id
                    ? 'bg-sky-600/60 text-sky-100'
                    : 'text-slate-400 hover:bg-slate-700/50 hover:text-slate-200'
                }`}
              >
                {tool.label}
              </button>
            ))}
          </nav>
        </div>

        {/* Right: Content panel */}
        <div
          className={`flex-1 min-w-0 min-h-0 rounded-lg border border-slate-600/60 bg-slate-800/30 p-6 ${
            contentOverflow === 'hidden' ? 'overflow-hidden' : 'overflow-y-auto'
          }`}
        >
          <SelectedPanel />
        </div>
      </div>

      {/* Output Log - collapsible, collapsed by default, expanded when a tool runs */}
      <div
        className={`flex flex-col min-w-0 transition-all overflow-hidden rounded-lg border border-slate-600/60 bg-slate-800/40 ${
          showOutputLog ? 'flex-[4_1_0] min-h-0' : 'shrink-0'
        }`}
      >
        <button
          type="button"
          onClick={() => setShowOutputLog((prev) => !prev)}
          className="flex items-center justify-between w-full px-4 py-2 hover:bg-slate-700/50 text-left transition-colors"
        >
          <span className="text-sm font-medium text-slate-300">Output Log</span>
          <span
            className={`inline-block text-slate-400 text-xs transition-transform ${
              showOutputLog ? 'rotate-180' : ''
            }`}
          >
            ▼
          </span>
        </button>
        {showOutputLog && (
          <div className="flex-1 min-h-0 flex flex-col min-w-0 overflow-hidden border-t border-slate-600/60 p-4">
            <OutputLogPanel />
          </div>
        )}
      </div>
    </div>
  );
}
