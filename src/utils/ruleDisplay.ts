export interface RuleDisplayInfo {
  label: string;
  badge: string;
  badgeColor: string;
}

export const RULE_COLORS: Record<string, string> = {
  'gc-hitch': '#ef4444',
  'taskgraph-wait': '#f97316',
  'cpu-hitch': '#eab308',
  'shader-compile': '#eab308',
  'pso-hitch': '#84cc16',
  'sync-load': '#06b6d4',
  'async-load-finalization': '#3b82f6',
  'spawn-burst': '#10b981',
  'bp-tick': '#8b5cf6',
  'physics-cpu': '#ec4899',
  'animation-cpu': '#d946ef',
  'editor-overhead': '#64748b',
  'ui-slate': '#6366f1',
  'gpu-niagara-fx': '#f43f5e',
  'gpu-lumen': '#fb7185',
  'gpu-vsm-shadows': '#e11d48',
  'gpu-shadow-views': '#dc2626',
  'gpu-nanite': '#be123c',
  'gpu-basepass': '#ff7849',
  'gpu-postprocess': '#ff4b81',
  'gpu-direct-lighting': '#f59e0b',
  'gpu-translucency': '#06b6d4',
  'gpu-bound': '#e11d48',
  'render-cpu': '#a855f7',
  'render-flush': '#9333ea',
  'level-streaming': '#0284c7',
  'unattributed-gap': '#64748b',
};

export function getRuleDisplayLabel(
  ruleId: string,
  title?: string,
  threadRole?: string
): RuleDisplayInfo {
  const normalized = (ruleId || '').toLowerCase().replace(/_/g, '-');
  const tLower = (title || '').toLowerCase();
  const role = (threadRole || '').toLowerCase();

  switch (normalized) {
    case 'gpu-niagara-fx':
      return { label: 'GPU: Niagara Particles', badge: 'Niagara', badgeColor: 'bg-rose-500/20 text-rose-300 border-rose-500/30' };
    case 'gpu-lumen':
      return { label: 'GPU: Lumen GI & Refl', badge: 'Lumen', badgeColor: 'bg-pink-500/20 text-pink-300 border-pink-500/30' };
    case 'gpu-vsm-shadows':
      return { label: 'GPU: Virtual Shadows', badge: 'VSM', badgeColor: 'bg-red-500/20 text-red-300 border-red-500/30' };
    case 'gpu-shadow-views':
      if (role === 'render' || tLower.includes('render')) {
        return { label: 'Render: Shadow Setup', badge: 'Shadows (Render)', badgeColor: 'bg-purple-600/20 text-purple-300 border-purple-600/30' };
      }
      return { label: 'GPU: Shadow Views', badge: 'Shadows', badgeColor: 'bg-red-600/20 text-red-300 border-red-600/30' };
    case 'regime-shift':
      return { label: 'Performance Regime Shift', badge: 'Regime', badgeColor: 'bg-amber-500/20 text-amber-300 border-amber-500/30' };
    case 'gpu-nanite':
      return { label: 'GPU: Nanite Raster', badge: 'Nanite', badgeColor: 'bg-rose-600/20 text-rose-300 border-rose-600/30' };
    case 'gpu-basepass':
      return { label: 'GPU: BasePass Shading', badge: 'BasePass', badgeColor: 'bg-orange-500/20 text-orange-300 border-orange-500/30' };
    case 'gpu-postprocess':
      return { label: 'GPU: PostProcess / TSR', badge: 'TSR/PP', badgeColor: 'bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-500/30' };
    case 'gpu-direct-lighting':
      return { label: 'GPU: Direct Lighting', badge: 'Lights', badgeColor: 'bg-amber-500/20 text-amber-300 border-amber-500/30' };
    case 'gpu-translucency':
      return { label: 'GPU: Translucency', badge: 'Translucent', badgeColor: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30' };
    case 'gpu-bound':
      return { label: 'GPU: Rendering Workload', badge: 'GPU', badgeColor: 'bg-rose-500/20 text-rose-300 border-rose-500/30' };
    case 'gc-hitch':
      return { label: 'CPU: Garbage Collection', badge: 'GC', badgeColor: 'bg-red-500/20 text-red-300 border-red-500/30' };
    case 'render-cpu':
      return { label: 'Render: Scene / Visibility', badge: 'Render CPU', badgeColor: 'bg-purple-500/20 text-purple-300 border-purple-500/30' };
    case 'render-flush':
      return { label: 'Render: GPU Flush Stall', badge: 'RHI Flush', badgeColor: 'bg-purple-600/20 text-purple-300 border-purple-600/30' };
    case 'bp-tick':
      return { label: 'Game: Blueprint Tick', badge: 'Blueprint', badgeColor: 'bg-violet-500/20 text-violet-300 border-violet-500/30' };
    case 'animation-cpu':
      return { label: 'Game: AnimGraph / Pose', badge: 'Animation', badgeColor: 'bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-500/30' };
    case 'physics-cpu':
      return { label: 'Game: Chaos Physics', badge: 'Physics', badgeColor: 'bg-pink-500/20 text-pink-300 border-pink-500/30' };
    case 'taskgraph-wait':
      return { label: 'TaskGraph: Worker Stall', badge: 'TaskGraph', badgeColor: 'bg-orange-500/20 text-orange-300 border-orange-500/30' };
    case 'shader-compile':
      return { label: 'Async: Shader Compilation', badge: 'Shaders', badgeColor: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/30' };
    case 'pso-hitch':
      return { label: 'Pipeline: PSO Creation', badge: 'PSO', badgeColor: 'bg-lime-500/20 text-lime-300 border-lime-500/30' };
    case 'sync-load':
      return { label: 'I/O: Sync Asset Load', badge: 'Sync Load', badgeColor: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/30' };
    case 'async-load-finalization':
      return { label: 'I/O: PostLoad Finalization', badge: 'Async Load', badgeColor: 'bg-blue-500/20 text-blue-300 border-blue-500/30' };
    case 'spawn-burst':
      return { label: 'Game: Actor Spawning', badge: 'Spawn Burst', badgeColor: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' };
    case 'editor-overhead':
      return { label: 'Editor: Slate & Overhead', badge: 'Editor', badgeColor: 'bg-slate-500/20 text-slate-300 border-slate-500/30' };
    case 'ui-slate':
      return { label: 'UI: Slate Tick & Paint', badge: 'Slate UI', badgeColor: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30' };
    case 'level-streaming':
      return { label: 'World: Level Streaming', badge: 'Streaming', badgeColor: 'bg-sky-500/20 text-sky-300 border-sky-500/30' };
    case 'cpu-hitch':
      return { label: 'Game: CPU Execution Spike', badge: 'CPU SPIKE', badgeColor: 'bg-amber-500/20 text-amber-300 border-amber-500/30' };
    case 'frame-limiter':
      return { label: 'System: Frame Limiter', badge: 'Limiter', badgeColor: 'bg-slate-500/20 text-slate-300 border-slate-500/30' };
    case 'inconclusive':
      return { label: 'System: Unprofiled Spike', badge: 'Unprofiled', badgeColor: 'bg-slate-700/40 text-slate-300 border-slate-600/40' };
    case 'unattributed-gap':
      return { label: 'System: Unattributed Gap', badge: 'Gap', badgeColor: 'bg-slate-700/40 text-slate-300 border-slate-600/40' };
    default:
      // Domain heuristics from title / normalized rule
      if (tLower.includes('vsm') || tLower.includes('virtual shadow') || normalized.includes('vsm')) {
        return { label: 'GPU: Virtual Shadows', badge: 'VSM', badgeColor: 'bg-red-500/20 text-red-300 border-red-500/30' };
      }
      if (tLower.includes('shadow') || normalized.includes('shadow')) {
        return { label: 'GPU: Shadow Views', badge: 'Shadows', badgeColor: 'bg-red-600/20 text-red-300 border-red-600/30' };
      }
      if (tLower.includes('lumen') || normalized.includes('lumen')) {
        return { label: 'GPU: Lumen GI & Refl', badge: 'Lumen', badgeColor: 'bg-pink-500/20 text-pink-300 border-pink-500/30' };
      }
      if (tLower.includes('nanite') || normalized.includes('nanite')) {
        return { label: 'GPU: Nanite Raster', badge: 'Nanite', badgeColor: 'bg-rose-600/20 text-rose-300 border-rose-600/30' };
      }
      if (tLower.includes('niagara') || tLower.includes('particle') || normalized.includes('niagara')) {
        return { label: 'GPU: Niagara Particles', badge: 'Niagara', badgeColor: 'bg-rose-500/20 text-rose-300 border-rose-500/30' };
      }
      if (role === 'gpu' || normalized.startsWith('gpu') || tLower.includes('gpu')) {
        return { label: 'GPU: Rendering Workload', badge: 'GPU', badgeColor: 'bg-rose-500/20 text-rose-300 border-rose-500/30' };
      }
      if (tLower.includes('garbage collection') || tLower.includes('gc') || normalized.includes('gc')) {
        return { label: 'CPU: Garbage Collection', badge: 'GC', badgeColor: 'bg-red-500/20 text-red-300 border-red-500/30' };
      }
      if (tLower.includes('blueprint') || normalized.includes('bp')) {
        return { label: 'Game: Blueprint Tick', badge: 'Blueprint', badgeColor: 'bg-violet-500/20 text-violet-300 border-violet-500/30' };
      }
      if (tLower.includes('anim') || normalized.includes('anim')) {
        return { label: 'Game: AnimGraph / Pose', badge: 'Animation', badgeColor: 'bg-fuchsia-500/20 text-fuchsia-300 border-fuchsia-500/30' };
      }
      if (tLower.includes('physics') || tLower.includes('chaos') || normalized.includes('physics')) {
        return { label: 'Game: Chaos Physics', badge: 'Physics', badgeColor: 'bg-pink-500/20 text-pink-300 border-pink-500/30' };
      }
      if (role === 'game' || normalized.includes('cpu') || normalized.includes('hitch') || tLower.includes('spike')) {
        return { label: 'Game: CPU Execution Spike', badge: 'CPU SPIKE', badgeColor: 'bg-amber-500/20 text-amber-300 border-amber-500/30' };
      }
      if (role === 'render' || normalized.includes('render') || tLower.includes('render')) {
        return { label: 'Render: Scene / Visibility', badge: 'Render CPU', badgeColor: 'bg-purple-500/20 text-purple-300 border-purple-500/30' };
      }
      return { label: ruleId, badge: 'System', badgeColor: 'bg-slate-700/40 text-slate-300 border-slate-600/40' };
  }
}
