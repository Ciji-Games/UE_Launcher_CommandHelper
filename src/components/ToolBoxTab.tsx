/**
 * ToolBox tab - vertical menu + content panel, Output Log.
 * Step 10: Two-column layout with ToolGroup panels. Step 11: UmapHelper.
 */

import { useState, useEffect, useCallback } from 'react';
import { useProgress } from '../contexts/ProgressContext';
import { LogAnalyzerImportProvider } from '../contexts/LogAnalyzerImportContext';
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

function ToolIcon({ id }: { id: ToolId }) {
  const paths: Record<ToolId, string> = {
    shader: 'M12 3v2m0 14v2M5.636 5.636l1.414 1.414m9.9 9.9l1.414 1.414M3 12h2m14 0h2M5.636 18.364l1.414-1.414m9.9-9.9l1.414-1.414M15.5 8.5l-1.25 3h2.25l-4 4 1.25-3h-2.25l4-4z',
    regenerate: 'M20 11a8 8 0 00-14.9-4M4 5v4h4M4 13a8 8 0 0014.9 4M20 19v-4h-4',
    batchcommit: 'M6 3v18m0-15h8a3 3 0 010 6H6m0 0h9a3 3 0 010 6H6',
    umap: 'M4 6l6-3 6 3 4-2v14l-4 2-6-3-6 3-4-2V4l4 2zm6-3v14m6-11v14',
    plugin: 'M9 7V5a3 3 0 016 0v2h2a2 2 0 012 2v2h2a3 3 0 010 6h-2v2a2 2 0 01-2 2h-2v-2a3 3 0 00-6 0v2H7a2 2 0 01-2-2v-2H3a3 3 0 010-6h2V9a2 2 0 012-2h2z',
    uproject: 'M5 3h9l5 5v13H5V3zm9 0v5h5M8 13h8m-8 4h5',
    movierenderqueue: 'M4 5a2 2 0 012-2h12a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V5zm0 4h16M9 3v6m6-6v6m-4 5l3 2-3 2v-4z',
    'log-analyzer': 'M4 19V5m0 14h16M7 15l3-4 3 2 4-6',
  };

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      className="h-4 w-4 shrink-0"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d={paths[id]} />
    </svg>
  );
}

export function ToolBoxTab({ initialRegenerateProjectPath }: { initialRegenerateProjectPath?: string | null }) {
  const [selectedToolId, setSelectedToolId] = useState<ToolId>(TOOLS[0].id);
  const [showOutputLog, setShowOutputLog] = useState(false);
  const { running, shouldOpenOutputLog } = useProgress();

  const selectedTool = TOOLS.find((t) => t.id === selectedToolId);
  const SelectedPanel = selectedTool?.panel ?? RegenerateProjectPanel;
  const contentOverflow = selectedTool?.contentOverflow ?? 'auto';

  useEffect(() => {
    if (running && shouldOpenOutputLog) setShowOutputLog(true);
  }, [running, shouldOpenOutputLog]);

  const openLogAnalyzer = useCallback(() => {
    setSelectedToolId('log-analyzer');
  }, []);

  useEffect(() => {
    if (initialRegenerateProjectPath) setSelectedToolId('regenerate');
  }, [initialRegenerateProjectPath]);

  return (
    <LogAnalyzerImportProvider onOpenAnalyzer={openLogAnalyzer}>
    <div className="flex flex-col gap-6 flex-1 min-h-0">
      {/* Tool area - fixed 60% of vertical space for stable layout when switching tools */}
      <div
        className={`flex gap-4 min-h-0 overflow-hidden transition-all flex-1 ${
          showOutputLog ? 'flex-[6_1_0]' : 'flex-[1_1_0]'
        }`}
      >
        {/* Left: Vertical menu */}
        <div className="w-60 shrink-0 flex flex-col">
          <nav className="flex flex-col gap-px rounded-lg overflow-hidden bg-slate-800/50 border border-slate-600/60">
            {TOOLS.map((tool) => (
              <button
                key={tool.id}
                type="button"
                onClick={() => setSelectedToolId(tool.id)}
                className={`flex items-center gap-2.5 whitespace-nowrap px-4 py-2.5 text-left text-sm font-medium transition-colors first:rounded-t-lg last:rounded-b-lg ${
                  selectedToolId === tool.id
                    ? 'bg-sky-600/60 text-sky-100'
                    : 'text-slate-400 hover:bg-slate-700/50 hover:text-slate-200'
                }`}
              >
                <ToolIcon id={tool.id} />
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
          {selectedToolId === 'regenerate' ? <RegenerateProjectPanel initialSelectedPath={initialRegenerateProjectPath} /> : <SelectedPanel />}
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
    </LogAnalyzerImportProvider>
  );
}
