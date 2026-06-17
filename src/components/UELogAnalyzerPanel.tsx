import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useLogAnalyzerImport } from '../contexts/LogAnalyzerImportContext';

const LEVELS = ['Fatal', 'Error', 'Warning', 'Display', 'Log', 'Verbose', 'VeryVerbose'] as const;
type Level = (typeof LEVELS)[number];
const levelSeverity: Record<Level, number> = Object.fromEntries(LEVELS.map((l, i) => [l, i])) as Record<
  Level,
  number
>;

const levelTextClass: Record<Level, string> = {
  Fatal: 'text-rose-400',
  Error: 'text-red-400',
  Warning: 'text-amber-300',
  Display: 'text-slate-400',
  Log: 'text-slate-300',
  Verbose: 'text-slate-400',
  VeryVerbose: 'text-slate-500',
};

const levelSvgColor: Record<Level, string> = {
  Fatal: '#fb7185',
  Error: '#f87171',
  Warning: '#fcd34d',
  Display: '#94a3b8',
  Log: '#cbd5e1',
  Verbose: '#94a3b8',
  VeryVerbose: '#64748b',
};

const levelBorderClass: Record<Level, string> = {
  Fatal: 'border-l-rose-500/70',
  Error: 'border-l-red-500/60',
  Warning: 'border-l-amber-400/60',
  Display: 'border-l-slate-500/30',
  Log: 'border-l-slate-500/20',
  Verbose: 'border-l-slate-500/20',
  VeryVerbose: 'border-l-slate-500/10',
};

const levelBgClass: Partial<Record<Level, string>> = {
  Fatal: 'bg-rose-950/20',
  Error: 'bg-red-950/15',
  Warning: 'bg-amber-950/10',
};

const IH = 18; // fixed row height for the virtual list

const QS: Record<string, string> = {
  '0': 'Very Low',
  '1': 'Low',
  '2': 'Medium',
  '3': 'High',
  '4': 'Very High',
  '5': 'Epic',
  '6': 'Cinematic',
};

function tsToMs(ts: string | null): number | null {
  if (!ts) return null;
  const m = ts.match(/(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2}):(\d{3})/);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]).getTime();
}

interface ParsedLine {
  idx: number;
  raw: string;
  ts: string | null;
  frame: number | null;
  cat: string | null;
  lvl: Level;
  msg: string;
}

function normalizeLevel(lvl: string | undefined): Level {
  if (!lvl) return 'Log';
  const key = lvl.toLowerCase();
  const map: Record<string, Level> = {
    fatal: 'Fatal',
    error: 'Error',
    warning: 'Warning',
    display: 'Display',
    log: 'Log',
    verbose: 'Verbose',
    veryverbose: 'VeryVerbose',
  };
  return map[key] ?? 'Log';
}

/** Infer level from launcher output log / plain text (no UE frame prefix). */
function inferLevelFromRaw(raw: string): Level | null {
  const t = raw.trim();
  const bracket = t.match(/^\[(ERROR|WARNING|WARN|FATAL)\]\s*(.*)$/i);
  if (bracket) {
    const tag = bracket[1].toUpperCase();
    if (tag === 'ERROR') return 'Error';
    if (tag === 'FATAL') return 'Fatal';
    return 'Warning';
  }
  const solo = t.match(/^(Fatal|Error|Warning|Display|Verbose|VeryVerbose):\s+/i);
  if (solo) return normalizeLevel(solo[1]);
  if (/:\s*Fatal:\s/i.test(t)) return 'Fatal';
  if (/:\s*Error:\s/i.test(t)) return 'Error';
  if (/:\s*Warning:\s/i.test(t)) return 'Warning';
  const lower = t.toLowerCase();
  if (lower.includes('[fatal]')) return 'Fatal';
  if (lower.includes('[error]')) return 'Error';
  if (lower.includes('[warning]') || lower.includes('[warn]')) return 'Warning';
  return null;
}

function applyInferredLevel(line: ParsedLine): ParsedLine {
  if (line.lvl !== 'Log') return line;
  const inferred = inferLevelFromRaw(line.raw);
  return inferred ? { ...line, lvl: inferred } : line;
}

function parseLine(raw: string, idx: number): ParsedLine {
  const bracket = raw.match(/^\[(ERROR|WARNING|WARN|FATAL)\]\s*(.*)$/i);
  if (bracket) {
    const tag = bracket[1].toUpperCase();
    const lvl: Level = tag === 'ERROR' ? 'Error' : tag === 'FATAL' ? 'Fatal' : 'Warning';
    return { idx, raw, ts: null, frame: null, cat: null, lvl, msg: bracket[2] || raw };
  }

  const b = raw.match(/^\[(\d{4}\.\d{2}\.\d{2}-\d{2}\.\d{2}\.\d{2}:\d{3})\]\[\s*(\d+)\](.*)/s);
  if (b) {
    const ts = b[1];
    const frame = parseInt(b[2], 10);
    const rest = b[3];
    const c = rest.match(/^([\w]+(?:\[[^\]]*\])*)(?:: (Fatal|Error|Warning|Display|Verbose|VeryVerbose))?: (.*)$/s);
    if (c) return applyInferredLevel({ idx, raw, ts, frame, cat: c[1], lvl: normalizeLevel(c[2]), msg: c[3] });
    const f = rest.match(/^(\w+)\s(.*)$/s);
    if (f) return applyInferredLevel({ idx, raw, ts, frame, cat: f[1], lvl: 'Log', msg: f[2] });
    return applyInferredLevel({ idx, raw, ts, frame, cat: null, lvl: 'Log', msg: rest });
  }
  const s = raw.match(/^([\w]+(?:\[[^\]]*\])*)(?:: (Fatal|Error|Warning|Display|Verbose|VeryVerbose))?: (.*)$/s);
  if (s) return applyInferredLevel({ idx, raw, ts: null, frame: null, cat: s[1], lvl: normalizeLevel(s[2]), msg: s[3] });
  return applyInferredLevel({ idx, raw, ts: null, frame: null, cat: null, lvl: 'Log', msg: raw });
}

interface ExtractedStats {
  hw: Record<string, string>;
  rhi: Record<string, string>;
  q: Record<string, string>;
  gpu: number[];
  locs: Record<string, number[]>;
  engine: string | null;
  os: string | null;
  cmd: string | null;
  netMode: string | null;
  frameTimes: number[];
}

function extractStats(lines: ParsedLine[]): ExtractedStats {
  const s: ExtractedStats = {
    hw: {},
    rhi: {},
    q: {},
    gpu: [],
    locs: {},
    engine: null,
    os: null,
    cmd: null,
    netMode: null,
    frameTimes: [],
  };
  let perfLoc: string | null = null;
  const frameFirstTs: Record<number, number> = {};

  for (const l of lines) {
    if (l.frame !== null && l.ts && frameFirstTs[l.frame] === undefined) {
      const ms = tsToMs(l.ts);
      if (ms !== null) frameFirstTs[l.frame] = ms;
    }
    const r = l.raw;
    const m = l.msg ?? '';
    const cat = l.cat ?? '';

    // Prefer the explicit "Engine Version:" line when present, because generic "UE 5.x"
    // matches can be wrong (plugins/binaries may mention other versions).
    if (!s.engine && r.includes('Engine Version:')) {
      const x = r.match(/Engine Version:\s*([^\r\n]+)/i);
      if (x) s.engine = `UE ${x[1].trim()}`;
    }
    if (!s.engine) {
      const x = r.match(/(?:Unreal Engine|UE)\s+([\d.]+(?:-\w+)?)/i);
      if (x) s.engine = `UE ${x[1]}`;
    }
    if (!s.os) {
      const x = r.match(/(?:Windows\s+[\w. ]+|macOS[\w. ]+|Linux[\w. ]+)/i);
      if (x) s.os = x[0].trim().slice(0, 50);
    }
    if (!s.netMode) {
      const x = r.match(/Net Mode:\s*(\w+)/i);
      if (x) s.netMode = x[1];
    }

    if (!s.hw.cpu && m.includes('CPU:')) s.hw.cpu = (m.split('CPU:')[1]?.split(',')[0] ?? '').trim().slice(0, 60);
    if (!s.hw.gpu) {
      const x =
        r.match(/Found D3D(?:11|12) adapter '([^']+)'/) ||
        r.match(/Chosen Vulkan device '([^']+)'/) ||
        r.match(/GPU Adapter:\s*([^\r\n,]+)/);
      if (x) s.hw.gpu = x[1].trim().slice(0, 60);
    }
    if (!s.hw.ram) {
      const x = r.match(/(\d+)\s*MB\s+total physical/i);
      if (x) {
        const mb = +x[1];
        s.hw.ram = mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
      }
    }
    if (!s.hw.vram) {
      const x = r.match(/(\d+)\s*MB[^,\n]*(?:VRAM|video memory|dedicated)/i);
      if (x) s.hw.vram = `${x[1]} MB`;
    }

    if (!s.rhi.api) {
      if (cat.includes('D3D12') || r.includes('D3D12RHI')) s.rhi.api = 'DirectX 12';
      else if (cat.includes('D3D11') || r.includes('D3D11RHI')) s.rhi.api = 'DirectX 11';
      else if (cat.includes('Vulkan')) s.rhi.api = 'Vulkan';
      else if (cat.includes('Metal')) s.rhi.api = 'Metal';
    }
    if (!s.rhi.fl) {
      const x = r.match(/Feature Level:\s*(SM[\w]+)/i);
      if (x) s.rhi.fl = x[1];
    }
    if (!s.rhi.sm) {
      const x = r.match(/Shader Model\s+([\d.]+)/i);
      if (x) s.rhi.sm = x[1];
    }
    if (!s.rhi.drv) {
      const x = r.match(/Driver Version:\s*([^\s,\n]+)/i);
      if (x) s.rhi.drv = x[1];
    }
    if (!s.rhi.sp) {
      const x = r.match(/r\.ScreenPercentage[^=]*=\s*([\d.]+)/i);
      if (x) s.rhi.sp = `${x[1]}%`;
    }
    if (!s.rhi.aa) {
      const x = r.match(/r\.AntiAliasingMethod[^=]*=\s*(\d+)/i);
      if (x) s.rhi.aa = { 0: 'None', 1: 'FXAA', 2: 'TAA', 3: 'MSAA', 4: 'TSR' }[x[1]] ?? x[1];
    }

    const qmap: Array<[string, string]> = [
      ['sg.ShadowQuality', 'sh'],
      ['sg.TextureQuality', 'tx'],
      ['sg.PostProcessQuality', 'pp'],
      ['sg.EffectsQuality', 'fx'],
      ['sg.FoliageQuality', 'fo'],
      ['sg.ViewDistanceQuality', 'vd'],
      ['sg.AntiAliasingQuality', 'aa'],
      ['sg.GlobalIlluminationQuality', 'gi'],
      ['sg.ReflectionQuality', 're'],
    ];
    for (const [k, p] of qmap) {
      if (!s.q[p] && r.includes(k)) {
        const x = r.match(new RegExp(k.replace(/\./g, '\\.') + '[^=]*=\\s*(\\d+)'));
        if (x) s.q[p] = QS[x[1]] ?? x[1];
      }
    }

    if (r.includes('PerfCam')) {
      const x = r.match(/\((\w+)PerfCam\)/);
      if (x) perfLoc = x[1];
    }
    if (r.includes('total GPU time ')) {
      const x = r.match(/total GPU time\s+([\d.]+)ms/);
      if (x) {
        const v = parseFloat(x[1]);
        s.gpu.push(v);
        if (perfLoc) {
          if (!s.locs[perfLoc]) s.locs[perfLoc] = [];
          s.locs[perfLoc].push(v);
        }
      }
    }

    if (!s.cmd && cat === 'LogInit' && m.startsWith('Command Line:')) s.cmd = m.replace('Command Line:', '').trim();
  }

  const frames = Object.keys(frameFirstTs)
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  for (let i = 0; i < frames.length - 1; i++) {
    const dt = frameFirstTs[frames[i + 1]] - frameFirstTs[frames[i]];
    if (dt > 0 && dt < 500) s.frameTimes.push(dt);
  }

  return s;
}

function calcStat(arr: number[]): { n: number; avg: number; med: number; min: number; max: number } | null {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const n = arr.length;
  const avg = arr.reduce((a, b) => a + b, 0) / n;
  return { n, avg, med: s[Math.floor(n / 2)], min: s[0], max: s[n - 1] };
}

type AnalyzerTab = 'navigator' | 'statistics' | 'summary';

type SummaryCard = {
  key: string;
  pattern: string;
  total: number;
  levels: Record<Level, number>;
  categories: Record<string, number>;
  differences: Record<string, number>;
};

function normalizeSummaryPattern(msg: string): string {
  const withTargetedRules = msg
    .replace(
      /Material\s+'[^']+'\s+expects texture\s+'[^']+'\s+to be Virtual/gi,
      "Material '<material>' expects texture '<texture>' to be Virtual"
    )
    .replace(/MemberName=\+"[^"]+"/g, 'MemberName=+"<name>"')
    .replace(/Name="\([^"]+\)"/g, 'Name="(<name>)"')
    .replace(/Pins\(Binding="[^"]+"\)/g, 'Pins(Binding="<binding>")')
    .replace(/Binding="[^"]+"/g, 'Binding="<binding>"')
    .replace(/MemberGuid\(([^)]*)\)/g, (_full, inner: string) => `MemberGuid(${inner.replace(/-?\d+/g, '<num>')})`)
    .replace(/\(0x[0-9A-Fa-f]+\)/g, '(<hex>)')
    .replace(/\b0x[0-9A-Fa-f]+\b/g, '<hex>')
    .replace(/(SelectActor:[^(]*\()([^)]+?)(\)\s+Flags:)/g, (_m, p1: string, actor: string, p3: string) => {
      return `${p1}${actor.replace(/\d+/g, '<num>')}${p3}`;
    });

  return withTargetedRules
    .replace(/\b[A-F0-9]{16,}\b/g, '<hash>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<num>')
    .replace(/\/[A-Za-z0-9_./-]+/g, '<asset>')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSummaryDifferences(msg: string): string[] {
  const found = new Set<string>();
  const quotedMatches = msg.match(/'[^']+'/g) ?? [];
  for (const q of quotedMatches) found.add(q);
  const quotedDoubleMatches = msg.match(/"[^"]+"/g) ?? [];
  for (const q of quotedDoubleMatches) found.add(q);
  const assetMatches = msg.match(/\/[A-Za-z0-9_./-]+/g) ?? [];
  for (const asset of assetMatches) found.add(asset);
  const hexMatches = msg.match(/\b0x[0-9A-Fa-f]+\b/g) ?? [];
  for (const h of hexMatches) found.add(h);
  const objectWithNumberMatches = msg.match(/\b[A-Za-z_][A-Za-z0-9_]*\d+[A-Za-z0-9_]*\b/g) ?? [];
  for (const v of objectWithNumberMatches) found.add(v);
  const hashMatches = msg.match(/\b[A-F0-9]{16,}\b/g) ?? [];
  for (const hash of hashMatches) found.add(hash);
  return [...found];
}

function buildSummaryCards(lines: ParsedLine[]): SummaryCard[] {
  const grouped: Record<string, SummaryCard> = {};
  for (const line of lines) {
    if (line.lvl !== 'Warning' && line.lvl !== 'Error' && line.lvl !== 'Fatal') continue;
    const source = line.msg || line.raw;
    const pattern = normalizeSummaryPattern(source);
    if (!pattern) continue;
    const key = `${line.lvl}|${pattern}`;
    const existing = grouped[key];
    const card =
      existing ??
      ({
        key,
        pattern,
        total: 0,
        levels: { Fatal: 0, Error: 0, Warning: 0, Display: 0, Log: 0, Verbose: 0, VeryVerbose: 0 },
        categories: {},
        differences: {},
      } satisfies SummaryCard);
    card.total += 1;
    card.levels[line.lvl] += 1;
    const catKey = line.cat ?? 'Uncategorized';
    card.categories[catKey] = (card.categories[catKey] ?? 0) + 1;
    for (const diff of extractSummaryDifferences(source)) {
      card.differences[diff] = (card.differences[diff] ?? 0) + 1;
    }
    grouped[key] = card;
  }
  return Object.values(grouped).sort((a, b) => b.total - a.total);
}

type FrameGroup = {
  fk: string;
  label: string;
  lines: ParsedLine[];
  isInit?: boolean;
  frameMs?: number | null;
};

type RenderItem =
  | {
      type: 'hdr';
      fk: string;
      label: string;
      count: number;
      wl: Level;
      errCnt: number;
      warnCnt: number;
      frameMs: number | null;
    }
  | { type: 'ln'; line: ParsedLine };

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-[10px] uppercase tracking-widest text-slate-500">{children}</div>;
}

type CategorySummary = {
  name: string;
  lineCount: number;
  warnCount: number;
  errCount: number;
};

function CategoryFilterModal({
  open,
  onClose,
  categories,
  uncategorizedCount,
  enabled,
  onToggle,
  onSetCategoriesEnabled,
}: {
  open: boolean;
  onClose: () => void;
  categories: CategorySummary[];
  uncategorizedCount: number;
  enabled: Record<string, boolean>;
  onToggle: (category: string) => void;
  onSetCategoriesEnabled: (names: string[], value: boolean) => void;
}) {
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (open) setQuery('');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const filteredCategories = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return categories;
    return categories.filter((c) => c.name.toLowerCase().includes(q));
  }, [categories, query]);

  if (!open) return null;

  const enabledCount = categories.filter((c) => enabled[c.name] !== false).length;
  const shownEnabledCount = filteredCategories.filter((c) => enabled[c.name] !== false).length;
  const isFiltering = query.trim().length > 0;

  const bulkBtn =
    'rounded-md px-2.5 py-1 text-xs bg-slate-700/60 text-slate-200 hover:bg-slate-600/60 transition-colors shrink-0';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 sm:p-6 backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="flex w-full max-w-4xl max-h-[min(88vh,720px)] flex-col rounded-lg border border-slate-600/80 bg-slate-900 shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="category-filter-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-slate-700/60 px-4 py-3 shrink-0">
          <div>
            <h3 id="category-filter-title" className="text-sm font-semibold text-slate-100">
              Log categories
            </h3>
            <p className="text-xs text-slate-500 mt-0.5 tabular-nums">
              {enabledCount.toLocaleString()} / {categories.length.toLocaleString()} enabled
              {uncategorizedCount > 0 && ` · ${uncategorizedCount.toLocaleString()} uncategorized`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1.5 text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors"
            aria-label="Close"
          >
            <span className="text-lg leading-none">×</span>
          </button>
        </div>

        <div className="shrink-0 border-b border-slate-700/40 px-4 py-3 space-y-2.5">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter categories…"
            className="w-full rounded-md bg-slate-950/50 border border-slate-700/60 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 outline-none focus:ring-2 focus:ring-sky-500/30"
            autoFocus
          />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => onSetCategoriesEnabled(categories.map((c) => c.name), true)} className={bulkBtn}>
              All
            </button>
            <button type="button" onClick={() => onSetCategoriesEnabled(categories.map((c) => c.name), false)} className={bulkBtn}>
              None
            </button>
            <button
              type="button"
              onClick={() => {
                for (const { name } of filteredCategories) {
                  onToggle(name);
                }
              }}
              disabled={filteredCategories.length === 0}
              className={`${bulkBtn} disabled:opacity-40 disabled:cursor-not-allowed`}
              title="Toggle each visible category"
            >
              Invert shown
            </button>
            {isFiltering && (
              <>
                <span className="w-px h-4 bg-slate-600/80 shrink-0" aria-hidden />
                <button
                  type="button"
                  onClick={() => onSetCategoriesEnabled(filteredCategories.map((c) => c.name), true)}
                  className={bulkBtn}
                >
                  All shown
                </button>
                <button
                  type="button"
                  onClick={() => onSetCategoriesEnabled(filteredCategories.map((c) => c.name), false)}
                  className={bulkBtn}
                >
                  None shown
                </button>
              </>
            )}
            <span className="ml-auto text-xs text-slate-500 tabular-nums">
              {isFiltering
                ? `${shownEnabledCount}/${filteredCategories.length} on · ${filteredCategories.length} shown`
                : `${categories.length} total`}
            </span>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-4 py-3">
          {categories.length === 0 ? (
            <p className="text-sm text-slate-500 py-8 text-center">No categories detected in this log.</p>
          ) : filteredCategories.length === 0 ? (
            <p className="text-sm text-slate-500 py-8 text-center">No categories match &quot;{query.trim()}&quot;.</p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-1.5">
              {filteredCategories.map(({ name, lineCount, warnCount, errCount }) => {
                const on = enabled[name] !== false;
                const statsTitle = [
                  `${lineCount.toLocaleString()} lines`,
                  warnCount > 0 ? `${warnCount.toLocaleString()} warnings` : '',
                  errCount > 0 ? `${errCount.toLocaleString()} errors` : '',
                ]
                  .filter(Boolean)
                  .join(', ');
                return (
                  <button
                    key={name}
                    type="button"
                    onClick={() => onToggle(name)}
                    className={`min-w-0 rounded-md border px-2 py-1.5 text-left transition-colors ${
                      on
                        ? 'border-sky-500/45 bg-sky-900/30 text-slate-100 hover:bg-sky-900/45'
                        : 'border-slate-700/50 bg-slate-950/50 text-slate-500 hover:border-slate-600/60 hover:text-slate-400'
                    }`}
                    title={`${name} — ${statsTitle}`}
                  >
                    <div className="font-mono text-[10px] leading-tight truncate">{name}</div>
                    <div className="flex items-center gap-1.5 mt-0.5 text-[10px] tabular-nums">
                      <span className={on ? 'text-sky-300/70' : 'text-slate-600'}>{lineCount.toLocaleString()}</span>
                      {warnCount > 0 && (
                        <span className="inline-flex items-center gap-0.5 text-amber-400" title={`${warnCount} warnings`}>
                          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0" aria-hidden />
                          {warnCount.toLocaleString()}
                        </span>
                      )}
                      {errCount > 0 && (
                        <span className="inline-flex items-center gap-0.5 text-red-400" title={`${errCount} errors`}>
                          <span className="w-1.5 h-1.5 rounded-full bg-red-400 shrink-0" aria-hidden />
                          {errCount.toLocaleString()}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
          {uncategorizedCount > 0 && categories.length > 0 && (
            <p className="text-[11px] text-slate-500 pt-3 mt-2 border-t border-slate-800/80">
              Lines without a category are always visible in the log view.
            </p>
          )}
        </div>

        <div className="shrink-0 border-t border-slate-700/60 px-4 py-3 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 rounded-md px-3 py-2 text-sm bg-sky-600/70 text-sky-50 hover:bg-sky-500/70 transition-colors"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

export function UELogAnalyzerPanel() {
  const { pendingImport, clearPendingImport } = useLogAnalyzerImport();
  const [lines, setLines] = useState<ParsedLine[]>([]);
  const [stats, setStats] = useState<ExtractedStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [fileName, setFileName] = useState<string | null>(null);
  const [tab, setTab] = useState<AnalyzerTab>('navigator');
  const [isDragOver, setIsDragOver] = useState(false);

  const [lvlFlt, setLvlFlt] = useState<Record<Level, boolean>>({
    Fatal: true,
    Error: true,
    Warning: true,
    Display: true,
    Log: true,
    Verbose: true,
    VeryVerbose: false,
  });
  const [catEnabled, setCatEnabled] = useState<Record<string, boolean>>({});
  const [categoryModalOpen, setCategoryModalOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const [scrollTop, setScrollTop] = useState(0);
  const [contH, setContH] = useState(600);

  const logRef = useRef<HTMLDivElement | null>(null);
  const lastScrollTopRef = useRef(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const minimapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mmDragging = useRef(false);

  const processText = useCallback(async (text: string, fname: string) => {
    setLoading(true);
    setProgress(0);
    setLines([]);
    setStats(null);
    setFileName(fname);
    setCollapsed({ init: true });
    setCatEnabled({});
    setScrollTop(0);

    const raw = text.split('\n');
    const parsed: ParsedLine[] = [];
    for (let i = 0; i < raw.length; i += 8000) {
      for (const r of raw.slice(i, i + 8000)) {
        const t = r.trimEnd();
        if (t) parsed.push(parseLine(t, parsed.length));
      }
      setProgress(Math.min(88, Math.round((i / raw.length) * 88)));
      await new Promise((r) => setTimeout(r, 0));
    }
    setProgress(94);
    await new Promise((r) => setTimeout(r, 0));
    setStats(extractStats(parsed));
    setLines(parsed);
    setProgress(100);
    setLoading(false);
  }, []);

  const handleFile = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = (ev) => processText(String(ev.target?.result ?? ''), f.name);
      rd.readAsText(f, 'utf-8');
      e.target.value = '';
    },
    [processText]
  );

  const loadDroppedPath = useCallback(
    async (path: string) => {
      try {
        const text = await invoke<string>('read_text_file', { path });
        const fname = path.split(/[/\\]/).pop() ?? 'dropped.log';
        await processText(text, fname);
      } catch {
        // Drop failed (permissions, missing file, etc.)
      }
    },
    [processText]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      const f = e.dataTransfer?.files?.[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = (ev) => processText(String(ev.target?.result ?? ''), f.name);
      rd.readAsText(f, 'utf-8');
    },
    [processText]
  );

  const handleClipboard = useCallback(async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (t.trim()) processText(t, 'clipboard.log');
    } catch {
      // Keep this intentionally lightweight; clipboard can be blocked by OS/webview policy.
      window.alert('Clipboard access denied.');
    }
  }, [processText]);

  useEffect(() => {
    if (!pendingImport) return;
    const { text, fileName } = pendingImport;
    clearPendingImport();
    void processText(text, fileName);
  }, [pendingImport, processText, clearPendingImport]);

  // Tauri v2 native file drop (tauri://file-drop* events are v1 and do not fire here).
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const start = async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        unlisten = await win.onDragDropEvent((event) => {
          const p = event.payload;
          if (p.type === 'over') {
            setIsDragOver(true);
            return;
          }
          if (p.type === 'drop') {
            setIsDragOver(false);
            const first = p.paths?.[0];
            if (first) void loadDroppedPath(first);
            return;
          }
          setIsDragOver(false);
        });
      } catch {
        // Native drop unavailable; HTML drop handler remains as fallback.
      }
    };

    void start();
    return () => {
      unlisten?.();
    };
  }, [loadDroppedPath]);

  const attachLog = useCallback((el: HTMLDivElement | null) => {
    logRef.current = el;
    if (!el) return;

    // Restore scroll position after remount (tab switch), and immediately sync state so
    // the virtual window renders where the DOM is.
    // rAF ensures layout has happened and scrollHeight is correct.
    requestAnimationFrame(() => {
      if (!logRef.current) return;
      logRef.current.scrollTop = lastScrollTopRef.current;
      setScrollTop(logRef.current.scrollTop);
      setContH(logRef.current.clientHeight);
    });

    setContH(el.clientHeight);
    const ro = new ResizeObserver(() => {
      if (logRef.current) setContH(logRef.current.clientHeight);
    });
    ro.observe(el);
    (el as unknown as { _ro?: ResizeObserver })._ro = ro;
  }, []);

  const detachLog = useCallback(() => {
    const el = logRef.current;
    if (el) {
      lastScrollTopRef.current = el.scrollTop;
      const anyEl = el as unknown as { _ro?: ResizeObserver };
      if (anyEl._ro) {
        anyEl._ro.disconnect();
        delete anyEl._ro;
      }
    }
    logRef.current = null;
  }, []);

  const logRefCb = useCallback(
    (el: HTMLDivElement | null) => {
      if (el) attachLog(el);
      else detachLog();
    },
    [attachLog, detachLog]
  );

  const lvlCounts = useMemo(() => {
    const c: Record<Level, number> = {
      Fatal: 0,
      Error: 0,
      Warning: 0,
      Display: 0,
      Log: 0,
      Verbose: 0,
      VeryVerbose: 0,
    };
    for (const l of lines) c[l.lvl] = (c[l.lvl] ?? 0) + 1;
    return c;
  }, [lines]);

  const cats = useMemo<CategorySummary[]>(() => {
    const c: Record<string, { lineCount: number; warnCount: number; errCount: number }> = {};
    for (const l of lines) {
      if (!l.cat) continue;
      const entry = c[l.cat] ?? { lineCount: 0, warnCount: 0, errCount: 0 };
      entry.lineCount += 1;
      if (l.lvl === 'Warning') entry.warnCount += 1;
      if (l.lvl === 'Fatal' || l.lvl === 'Error') entry.errCount += 1;
      c[l.cat] = entry;
    }
    return Object.entries(c)
      .map(([name, s]) => ({ name, ...s }))
      .sort((a, b) => b.lineCount - a.lineCount);
  }, [lines]);

  const uncategorizedCount = useMemo(() => lines.filter((l) => !l.cat).length, [lines]);

  const enabledCategoryCount = useMemo(
    () => cats.filter((c) => catEnabled[c.name] !== false).length,
    [cats, catEnabled]
  );

  useEffect(() => {
    setCatEnabled((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const { name } of cats) {
        if (!(name in next)) {
          next[name] = true;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [cats]);

  const filtered = useMemo(() => {
    let r = lines.filter((l) => lvlFlt[l.lvl] !== false);
    r = r.filter((l) => !l.cat || catEnabled[l.cat] !== false);
    if (search.trim()) {
      const q = search.toLowerCase();
      r = r.filter((l) => l.raw.toLowerCase().includes(q));
    }
    return r;
  }, [lines, lvlFlt, catEnabled, search]);

  const summaryCards = useMemo(() => buildSummaryCards(filtered), [filtered]);

  const toggleCategory = useCallback((category: string) => {
    setCatEnabled((p) => ({ ...p, [category]: p[category] === false }));
  }, []);

  const setCategoriesEnabled = useCallback((names: string[], value: boolean) => {
    setCatEnabled((p) => {
      const next = { ...p };
      for (const n of names) next[n] = value;
      return next;
    });
  }, []);

  const hasFrameNumbers = useMemo(() => lines.some((l) => l.frame !== null), [lines]);

  const frameGroups = useMemo<FrameGroup[]>(() => {
    if (!hasFrameNumbers) return [];
    const fi = filtered.findIndex((l) => l.frame !== null);
    const initLines = fi === -1 ? filtered : filtered.slice(0, fi);
    const mainLines = fi === -1 ? [] : filtered.slice(fi);
    const gs: FrameGroup[] = [];
    if (initLines.length) gs.push({ fk: 'init', lines: initLines, label: 'Initialization', isInit: true });
    let cur: FrameGroup | null = null;
    for (const l of mainLines) {
      if (l.frame === null) {
        if (cur) cur.lines.push(l);
      } else if (!cur) {
        cur = { fk: String(l.frame), lines: [l], label: `Frame ${l.frame}` };
        gs.push(cur);
      } else if (String(l.frame) === cur.fk) cur.lines.push(l);
      else {
        cur = { fk: String(l.frame), lines: [l], label: `Frame ${l.frame}` };
        gs.push(cur);
      }
    }
    for (let i = 0; i < gs.length; i++) {
      if (gs[i].isInit) continue;
      const st = gs[i].lines.find((l) => l.ts)?.ts ?? null;
      let nx: string | null = null;
      for (let j = i + 1; j < gs.length; j++) {
        if (!gs[j].isInit) {
          nx = gs[j].lines.find((l) => l.ts)?.ts ?? null;
          if (nx) break;
        }
      }
      if (st && nx) {
        const dt = (tsToMs(nx) ?? 0) - (tsToMs(st) ?? 0);
        if (dt > 0 && dt < 500) gs[i].frameMs = dt;
      }
    }
    return gs;
  }, [filtered, hasFrameNumbers]);

  const renderItems = useMemo<RenderItem[]>(() => {
    if (!hasFrameNumbers) {
      return filtered.map((line): RenderItem => ({ type: 'ln', line }));
    }
    const items: RenderItem[] = [];
    for (const g of frameGroups) {
      const wl = g.lines.reduce<Level>((w, l) => (levelSeverity[l.lvl] > levelSeverity[w] ? l.lvl : w), 'VeryVerbose');
      const errCnt = g.lines.filter((l) => l.lvl === 'Fatal' || l.lvl === 'Error').length;
      const warnCnt = g.lines.filter((l) => l.lvl === 'Warning').length;
      items.push({
        type: 'hdr',
        fk: g.fk,
        label: g.label,
        count: g.lines.length,
        wl,
        errCnt,
        warnCnt,
        frameMs: g.frameMs ?? null,
      });
      if (!collapsed[g.fk]) for (const l of g.lines) items.push({ type: 'ln', line: l });
    }
    return items;
  }, [frameGroups, collapsed, filtered, hasFrameNumbers]);

  const totalH = renderItems.length * IH;
  const si = Math.max(0, Math.floor(scrollTop / IH) - 60);
  const ei = Math.min(renderItems.length, Math.ceil((scrollTop + contH) / IH) + 60);
  const vpTop = totalH > 0 ? (scrollTop / totalH) * 100 : 0;
  const vpH = totalH > 0 ? Math.max(2, (contH / totalH) * 100) : 100;

  useEffect(() => {
    const canvas = canvasRef.current;
    const el = minimapRef.current;
    if (!canvas || !el || renderItems.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      const W = el.clientWidth || 44;
      const H = el.clientHeight || 600;
      canvas.width = W;
      canvas.height = H;

      const n = renderItems.length;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = '#0b1220';
      ctx.fillRect(0, 0, W, H);

      for (let i = 0; i < n; i++) {
        const it = renderItems[i];
        if (it.type === 'hdr') {
          ctx.fillStyle = 'rgba(255,255,255,0.05)';
          ctx.fillRect(0, (i / n) * H, W, Math.max(1, H / n));
        }
      }
      for (let i = 0; i < n; i++) {
        const it = renderItems[i];
        if (it.type !== 'ln') continue;
        if (it.line.lvl === 'Warning') {
          ctx.fillStyle = 'rgba(245,158,11,0.45)';
          ctx.fillRect(0, (i / n) * H, W, Math.max(2, H / n));
        }
      }
      for (let i = 0; i < n; i++) {
        const it = renderItems[i];
        if (it.type !== 'ln') continue;
        if (it.line.lvl === 'Fatal') {
          ctx.fillStyle = 'rgba(244,63,94,0.95)';
          ctx.fillRect(0, (i / n) * H, W, Math.max(4, H / n));
        } else if (it.line.lvl === 'Error') {
          ctx.fillStyle = 'rgba(248,113,113,0.85)';
          ctx.fillRect(0, (i / n) * H, W, Math.max(3, H / n));
        }
      }
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(el);
    return () => ro.disconnect();
  }, [renderItems]);

  const scrollToMmY = useCallback((clientY: number) => {
    const el = minimapRef.current;
    const sc = logRef.current;
    if (!el || !sc) return;
    const r = el.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientY - r.top) / r.height));
    sc.scrollTop = ratio * (sc.scrollHeight - sc.clientHeight);
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (mmDragging.current) scrollToMmY(e.clientY);
    };
    const onUp = () => {
      mmDragging.current = false;
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [scrollToMmY]);

  const toggleAll = useCallback(() => {
    const keys = frameGroups.map((g) => g.fk);
    setCollapsed((p) => {
      const anyOpen = keys.some((k) => !p[k]);
      return Object.fromEntries(keys.map((k) => [k, anyOpen])) as Record<string, boolean>;
    });
  }, [frameGroups]);

  const stickyHdr = useMemo<Extract<RenderItem, { type: 'hdr' }> | null>(() => {
    if (!hasFrameNumbers || renderItems.length === 0) return null;
    const topIdx = Math.min(renderItems.length - 1, Math.floor(scrollTop / IH) + 1);
    for (let i = topIdx; i >= 0; i--) {
      const it = renderItems[i];
      if (it.type === 'hdr') return collapsed[it.fk] ? null : it;
    }
    return null;
  }, [renderItems, scrollTop, collapsed, hasFrameNumbers]);

  if (loading) {
    return (
      <div className="h-full min-h-0 flex flex-col items-center justify-center gap-4">
        <div className="text-xs text-slate-500 tracking-widest uppercase">
          Parsing {fileName ?? 'file'}…
        </div>
        <div className="w-72 h-2 rounded bg-slate-800 overflow-hidden border border-slate-700/50">
          <div className="h-full bg-sky-500 transition-[width] duration-100" style={{ width: `${progress}%` }} />
        </div>
        <div className="text-xs text-slate-500 tabular-nums">{progress}%</div>
      </div>
    );
  }

  if (!lines.length) {
    return (
      <div className="h-full min-h-0 flex flex-col">
        <div className="flex items-center gap-3 pb-4 border-b border-slate-700/60">
          <div className="text-sm font-medium text-slate-200">UE Log Analyzer</div>
          <div className="text-xs text-slate-500">Standalone log inspection (separate from Output Log)</div>
        </div>

        <div
          className={`flex-1 min-h-0 flex items-center justify-center ${
            isDragOver ? 'bg-slate-900/40' : ''
          } transition-colors`}
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragOver(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setIsDragOver(false);
          }}
          onDrop={handleDrop}
        >
          <div
            className={`flex flex-col items-center gap-4 px-10 py-10 rounded-lg border border-dashed ${
              isDragOver ? 'border-sky-500/70' : 'border-slate-600/60'
            } bg-slate-900/30`}
          >
            <div className={`text-sm ${isDragOver ? 'text-sky-300' : 'text-slate-400'} transition-colors`}>
              {isDragOver ? 'Release to analyze' : 'Drop a .log / .txt file here'}
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <label className="cursor-pointer rounded-md px-3 py-2 text-sm bg-slate-700/60 text-slate-200 hover:bg-slate-600/60 transition-colors">
                <input type="file" accept=".log,.txt" className="hidden" onChange={handleFile} />
                Open file
              </label>
              <button
                type="button"
                onClick={handleClipboard}
                className="rounded-md px-3 py-2 text-sm bg-slate-700/60 text-slate-200 hover:bg-slate-600/60 transition-colors"
              >
                Paste clipboard
              </button>
            </div>
            <div className="text-xs text-slate-500">All processing is local.</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="h-full min-h-0 flex flex-col overflow-hidden relative"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setIsDragOver(false);
      }}
      onDrop={handleDrop}
    >
      {/* Top bar */}
      <div className="flex items-center gap-3 pb-3 border-b border-slate-700/60 overflow-x-auto">
        <div className="text-sm font-medium text-slate-200 shrink-0">UE Log Analyzer</div>
        <div className="text-xs text-slate-500 max-w-[16rem] truncate" title={fileName ?? undefined}>
          {fileName}
        </div>
        <div className="text-xs text-slate-500 tabular-nums shrink-0">{lines.length.toLocaleString()} lines</div>
        <div className="flex-1" />

        <label className="cursor-pointer rounded-md px-3 py-1.5 text-sm bg-slate-700/60 text-slate-200 hover:bg-slate-600/60 transition-colors shrink-0">
          <input type="file" accept=".log,.txt" className="hidden" onChange={handleFile} />
          Open file
        </label>
      </div>

      {/* Tabs */}
      <div className="flex items-end gap-2 pt-3 pb-3 border-b border-slate-700/60">
        {(['navigator', 'statistics', 'summary'] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 rounded-md text-sm capitalize transition-colors ${
              tab === t ? 'bg-sky-600/30 text-sky-100' : 'text-slate-400 hover:bg-slate-800/40 hover:text-slate-200'
            }`}
          >
            {t}
          </button>
        ))}
        <div className="flex-1" />
        <div className="text-xs text-slate-500 tabular-nums">{filtered.length.toLocaleString()} shown</div>
      </div>

      {/* Drag overlay (works in both tabs) */}
      {isDragOver && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-slate-950/40 backdrop-blur-sm">
          <div className="rounded-lg border border-dashed border-sky-500/70 bg-slate-900/50 px-10 py-8 text-center">
            <div className="text-sm text-sky-200">Drop to analyze</div>
            <div className="mt-1 text-xs text-slate-400">Supported: .log, .txt</div>
          </div>
        </div>
      )}

      {/* Navigator (kept mounted so scroll/minimap state persists across tab switches) */}
      <div className={tab === 'navigator' ? 'flex-1 min-h-0 flex overflow-hidden' : 'hidden'}>
          {/* Sidebar */}
          <div className="w-52 shrink-0 border-r border-slate-700/60 pr-4 py-4 flex flex-col gap-3 overflow-y-auto">
            <div>
              <SectionLabel>Search</SectionLabel>
              <div className="mt-1 relative">
                <input
                  ref={searchInputRef}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filter logs…"
                  className={`w-full rounded-md bg-slate-900/40 border border-slate-700/60 pl-2.5 py-2 text-sm text-slate-200 placeholder:text-slate-600 outline-none focus:ring-2 focus:ring-sky-500/30 ${
                    search.trim() ? 'pr-9' : 'pr-2.5'
                  }`}
                />
                {search.trim() && (
                  <button
                    type="button"
                    onClick={() => {
                      setSearch('');
                      searchInputRef.current?.focus();
                    }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-slate-500 hover:text-slate-200 hover:bg-slate-800/60 transition-colors"
                    aria-label="Clear search"
                    title="Clear"
                  >
                    <span className="text-base leading-none select-none">×</span>
                  </button>
                )}
              </div>
            </div>

            <div>
              <SectionLabel>Levels</SectionLabel>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {LEVELS.filter((l) => lvlCounts[l] > 0).map((lvl) => (
                  <button
                    key={lvl}
                    type="button"
                    onClick={() => setLvlFlt((p) => ({ ...p, [lvl]: !p[lvl] }))}
                    className={`px-2 py-1 rounded border text-[11px] font-mono transition-colors ${
                      lvlFlt[lvl]
                        ? 'border-slate-500/60 bg-slate-900/40 text-slate-200'
                        : 'border-slate-700/60 bg-transparent text-slate-500 hover:text-slate-300 hover:bg-slate-900/30'
                    }`}
                    title={`Toggle ${lvl}`}
                  >
                    <span className={levelTextClass[lvl]}>{lvl}</span>{' '}
                    <span className="text-slate-500">{lvlCounts[lvl].toLocaleString()}</span>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <SectionLabel>Category</SectionLabel>
              <button
                type="button"
                onClick={() => setCategoryModalOpen(true)}
                className="mt-1 w-full rounded-md px-2.5 py-2 text-sm text-left bg-slate-900/40 border border-slate-700/60 text-slate-200 hover:bg-slate-800/40 transition-colors"
              >
                {cats.length === 0
                  ? 'No categories'
                  : `${enabledCategoryCount} / ${cats.length} categories`}
              </button>
            </div>

            {hasFrameNumbers && (
              <div className="pt-1">
                <SectionLabel>Frame Tree</SectionLabel>
                <button
                  type="button"
                  onClick={toggleAll}
                  className="mt-1 w-full text-left rounded-md px-2.5 py-2 text-sm bg-slate-900/40 border border-slate-700/60 text-slate-200 hover:bg-slate-800/40 transition-colors flex items-center gap-2"
                >
                  <span className={`transition-transform duration-200 inline-block ${frameGroups.every((g) => collapsed[g.fk]) ? '' : 'rotate-90'}`}>▶</span>
                  {frameGroups.every((g) => collapsed[g.fk]) ? 'Expand All' : 'Collapse All'}
                </button>
              </div>
            )}
          </div>

          {/* Log area */}
          <div className="flex-1 min-w-0 min-h-0 flex overflow-hidden">
            <div
              ref={logRefCb}
              onScroll={(e) => {
                const next = e.currentTarget.scrollTop;
                lastScrollTopRef.current = next;
                setScrollTop(next);
              }}
              className="flex-1 min-h-0 min-w-0 overflow-auto relative"
            >
              {stickyHdr && (
                <button
                  type="button"
                  onClick={() => setCollapsed((p) => ({ ...p, [stickyHdr.fk]: !p[stickyHdr.fk] }))}
                  className={`sticky top-0 z-10 w-full h-[18px] flex items-center gap-2 px-2 text-left text-[11px] font-mono border-b border-slate-700/60 bg-slate-950/70 backdrop-blur ${
                    levelBorderClass[stickyHdr.wl]
                  } border-l-2`}
                  title="Toggle frame group"
                >
                  <span className={`text-slate-500 transition-transform duration-200 inline-block ${collapsed[stickyHdr.fk] ? '' : 'rotate-90'}`}>▶</span>
                  <span className="text-slate-400">{stickyHdr.label}</span>
                  <span className="text-slate-600">{stickyHdr.count}</span>
                  <span className="flex-1" />
                  {stickyHdr.frameMs != null && (
                    <span className="text-slate-600 tabular-nums">{stickyHdr.frameMs.toFixed(1)}ms</span>
                  )}
                  {stickyHdr.warnCnt > 0 && <span className="text-amber-300 tabular-nums">●{stickyHdr.warnCnt}</span>}
                  {stickyHdr.errCnt > 0 && <span className="text-red-400 tabular-nums">●{stickyHdr.errCnt}</span>}
                </button>
              )}

              <div style={{ height: totalH, position: 'relative' }}>
                <div style={{ position: 'absolute', top: si * IH, left: 0, right: 0 }}>
                  {renderItems.slice(si, ei).map((item) => {
                    if (item.type === 'hdr') {
                      const isC = !!collapsed[item.fk];
                      return (
                        <button
                          key={`h${item.fk}`}
                          type="button"
                          onClick={() => setCollapsed((p) => ({ ...p, [item.fk]: !p[item.fk] }))}
                          className={`w-full h-[18px] flex items-center gap-2 px-2 text-left text-[11px] font-mono border-l-2 ${
                            levelBorderClass[item.wl]
                          } ${isC ? 'bg-slate-900/20' : 'bg-slate-900/35'} hover:bg-slate-800/40 transition-colors`}
                        >
                          <span className="text-slate-500 w-4">{isC ? '▶' : '▼'}</span>
                          <span className="text-slate-400">{item.label}</span>
                          <span className="text-slate-600">{item.count}</span>
                          <span className="flex-1" />
                          {item.frameMs != null && <span className="text-slate-600 tabular-nums">{item.frameMs.toFixed(1)}ms</span>}
                          {item.warnCnt > 0 && <span className="text-amber-300 tabular-nums">●{item.warnCnt}</span>}
                          {item.errCnt > 0 && <span className="text-red-400 tabular-nums">●{item.errCnt}</span>}
                        </button>
                      );
                    }
                    return <LineRow key={`l${item.line.idx}`} line={item.line} search={search} />;
                  })}
                </div>
              </div>

              {renderItems.length === 0 && (
                <div className="p-6 text-sm text-slate-500">No lines match current filters.</div>
              )}
            </div>

            {/* Minimap */}
            <div
              ref={minimapRef}
              onMouseDown={(e) => {
                mmDragging.current = true;
                scrollToMmY(e.clientY);
                e.preventDefault();
              }}
              className="w-12 shrink-0 border-l border-slate-700/60 relative cursor-ns-resize select-none overflow-hidden bg-slate-950/40"
              title="Drag to scroll"
            >
              <canvas ref={canvasRef} className="block w-full h-full" />
              <div
                className="absolute left-0 right-0 pointer-events-none bg-white/5 border-y border-white/10"
                style={{ top: `${vpTop}%`, height: `${vpH}%` }}
              />
            </div>
          </div>
        </div>

      {/* Statistics (kept mounted to avoid remount churn) */}
      <div className={tab === 'statistics' ? 'flex-1 min-h-0 flex overflow-hidden' : 'hidden'}>
        {stats && <StatsPanel stats={stats} lvlCounts={lvlCounts} cats={cats} total={lines.length} />}
      </div>

      {/* Summary */}
      <div className={tab === 'summary' ? 'flex-1 min-h-0 flex overflow-hidden' : 'hidden'}>
        <SummaryPanel cards={summaryCards} shownCount={filtered.length} />
      </div>

      <CategoryFilterModal
        open={categoryModalOpen}
        onClose={() => setCategoryModalOpen(false)}
        categories={cats}
        uncategorizedCount={uncategorizedCount}
        enabled={catEnabled}
        onToggle={toggleCategory}
        onSetCategoriesEnabled={setCategoriesEnabled}
      />
    </div>
  );
}

function LineRow({ line, search }: { line: ParsedLine; search: string }) {
  const text = line.msg || line.raw;
  const q = search.trim().toLowerCase();
  const lo = q ? text.toLowerCase() : '';
  const idx = q ? lo.indexOf(q) : -1;

  const content =
    idx >= 0 ? (
      <>
        {text.slice(0, idx)}
        <mark className="bg-amber-500/20 text-amber-100 rounded px-0.5">{text.slice(idx, idx + search.length)}</mark>
        {text.slice(idx + search.length)}
      </>
    ) : (
      text
    );

  return (
    <div
      className={`h-[18px] flex items-center px-2 text-[11px] font-mono min-w-max border-l-2 ${
        levelBorderClass[line.lvl]
      } ${levelBgClass[line.lvl] ?? ''} hover:bg-slate-800/30`}
    >
      <span className="text-slate-600 w-14 text-right pr-2 tabular-nums select-none">{line.idx + 1}</span>
      {line.cat && <span className="text-slate-500 w-40 pr-2 truncate">{line.cat}</span>}
      {line.lvl !== 'Log' && line.lvl !== 'Display' && (
        <span className={`w-20 pr-2 text-[10px] ${levelTextClass[line.lvl]} opacity-90`}>{line.lvl}</span>
      )}
      <span className={`${levelTextClass[line.lvl]} whitespace-nowrap`}>{content}</span>
    </div>
  );
}

function SummaryPanel({ cards, shownCount }: { cards: SummaryCard[]; shownCount: number }) {
  if (cards.length === 0) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto py-6 px-4">
        <div className="rounded-lg border border-slate-800/70 bg-slate-950/30 p-4 text-sm text-slate-400">
          No warning/error patterns found in the current filtered view.
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto py-4 px-1">
      <div className="text-xs text-slate-500 px-3 pb-3">{cards.length.toLocaleString()} issue patterns from {shownCount.toLocaleString()} visible lines</div>
      <div className="flex flex-col gap-3 px-3 pb-4">
        {cards.map((card) => {
          const topCategories = Object.entries(card.categories)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3);
          const diffs = Object.entries(card.differences)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);
          return (
            <div key={card.key} className="rounded-lg border border-slate-700/60 bg-slate-950/30 p-3">
              <div className="flex items-center gap-2">
                <div className="text-sm text-slate-100 break-words">{card.pattern}</div>
                <div className="flex-1" />
                <div className="text-xs tabular-nums rounded bg-slate-800/80 px-2 py-0.5 text-slate-300">{card.total.toLocaleString()}x</div>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                {card.levels.Warning > 0 && <span className="rounded bg-amber-950/40 text-amber-300 px-2 py-0.5">Warning {card.levels.Warning}</span>}
                {card.levels.Error > 0 && <span className="rounded bg-red-950/40 text-red-300 px-2 py-0.5">Error {card.levels.Error}</span>}
                {card.levels.Fatal > 0 && <span className="rounded bg-rose-950/40 text-rose-300 px-2 py-0.5">Fatal {card.levels.Fatal}</span>}
                {topCategories.map(([name, count]) => (
                  <span key={name} className="rounded bg-slate-800/70 text-slate-300 px-2 py-0.5 truncate max-w-[16rem]" title={name}>
                    {name} · {count}
                  </span>
                ))}
              </div>
              {diffs.length > 0 && (
                <div className="mt-3 border-t border-slate-800/80 pt-2">
                  <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1">Differences</div>
                  <div className="flex flex-col gap-1.5">
                    {diffs.map(([value, count]) => (
                      <div key={value} className="text-xs flex items-start gap-2">
                        <span className="text-slate-600 tabular-nums w-8 text-right">{count}x</span>
                        <span className="text-slate-300 break-all">{value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StatsPanel({
  stats,
  lvlCounts,
  cats,
  total,
}: {
  stats: ExtractedStats;
  lvlCounts: Record<Level, number>;
  cats: CategorySummary[];
  total: number;
}) {
  const QN: Record<string, string> = {
    sh: 'Shadows',
    tx: 'Textures',
    pp: 'Post Process',
    fx: 'Effects',
    fo: 'Foliage',
    vd: 'View Distance',
    aa: 'Anti-Aliasing',
    gi: 'Global Illumination',
    re: 'Reflections',
  };

  const pieData = LEVELS.filter((l) => lvlCounts[l] > 0).map((l) => ({ l, v: lvlCounts[l] }));
  const pTot = pieData.reduce((s, d) => s + d.v, 0);

  let ang = -Math.PI / 2;
  const arcs = pieData.map((d) => {
    const st = ang;
    const sw = pTot > 0 ? (d.v / pTot) * 2 * Math.PI : 0;
    ang += sw;
    const x1 = 50 + 44 * Math.cos(st);
    const y1 = 50 + 44 * Math.sin(st);
    const x2 = 50 + 44 * Math.cos(ang);
    const y2 = 50 + 44 * Math.sin(ang);
    const large = sw > Math.PI ? 1 : 0;
    return { ...d, st, sw, large, x1, y1, x2, y2 };
  });

  const fps = calcStat(stats.frameTimes);
  const gpu = calcStat(stats.gpu);

  const Card = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <div className="rounded-lg border border-slate-700/60 bg-slate-900/30 p-4">
      <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-3">{title}</div>
      {children}
    </div>
  );

  const KV = ({ k, v }: { k: string; v: string | number | null | undefined }) => {
    if (v == null || v === '') return null;
    return (
      <div className="flex gap-3 text-sm">
        <div className="text-slate-500 w-32 shrink-0">{k}</div>
        <div className="text-slate-200 break-words">{String(v)}</div>
      </div>
    );
  };

  const StatGrid = ({
    rows,
  }: {
    rows: Array<[string, string, string | null]>;
  }) => (
    <div className="grid grid-cols-2 gap-2">
      {rows.map(([lbl, main, sub]) => (
        <div key={lbl} className="rounded-md bg-slate-950/30 border border-slate-800/50 px-3 py-2">
          <div className="text-[10px] uppercase tracking-widest text-slate-500">{lbl}</div>
          <div className="text-lg text-slate-100 tabular-nums mt-0.5">{main}</div>
          {sub && <div className="text-xs text-slate-500 mt-0.5">{sub}</div>}
        </div>
      ))}
    </div>
  );

  return (
    <div className="flex-1 min-h-0 overflow-y-auto py-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="flex flex-col gap-4">
          <Card title="Hardware">
            <div className="flex flex-col gap-1.5">
              <KV k="GPU" v={stats.hw.gpu} />
              <KV k="CPU" v={stats.hw.cpu} />
              <KV k="System RAM" v={stats.hw.ram} />
              <KV k="VRAM" v={stats.hw.vram} />
              <KV k="OS" v={stats.os} />
              {!stats.hw.gpu && !stats.hw.cpu && <div className="text-sm text-slate-500">Not detected.</div>}
            </div>
          </Card>

          <Card title="Rendering / RHI">
            <div className="flex flex-col gap-1.5">
              <KV k="Graphics API" v={stats.rhi.api} />
              <KV k="Feature Level" v={stats.rhi.fl} />
              <KV k="Shader Model" v={stats.rhi.sm} />
              <KV k="Anti-Aliasing" v={stats.rhi.aa} />
              <KV k="Driver Version" v={stats.rhi.drv} />
              <KV k="Screen %" v={stats.rhi.sp} />
              {!stats.rhi.api && <div className="text-sm text-slate-500">Not detected.</div>}
            </div>
          </Card>

          <Card title="Scalability">
            <div className="flex flex-col gap-1.5">
              {Object.entries(QN)
                .filter(([k]) => stats.q[k])
                .map(([k, label]) => (
                  <KV key={k} k={label} v={stats.q[k]} />
                ))}
              {!Object.values(stats.q).some(Boolean) && <div className="text-sm text-slate-500">Not detected.</div>}
            </div>
          </Card>

          {fps && (
            <Card title="Frame Rate">
              <div className="flex flex-col gap-3">
                <StatGrid
                  rows={[
                    ['Avg FPS', `${(1000 / fps.avg).toFixed(1)}`, `${fps.avg.toFixed(2)} ms avg`],
                    ['Median FPS', `${(1000 / fps.med).toFixed(1)}`, `${fps.med.toFixed(2)} ms`],
                    ['Best Frame', `${(1000 / fps.min).toFixed(1)} fps`, `${fps.min.toFixed(2)} ms`],
                    ['Worst Frame', `${(1000 / fps.max).toFixed(1)} fps`, `${fps.max.toFixed(2)} ms`],
                  ]}
                />
                <KV k="Frame samples" v={fps.n.toLocaleString()} />
              </div>
            </Card>
          )}

          {gpu && (
            <Card title="GPU Timing — ProfileGPU">
              <div className="flex flex-col gap-3">
                <StatGrid
                  rows={[
                    ['Avg', `${gpu.avg.toFixed(2)} ms`, `${(1000 / gpu.avg).toFixed(0)} fps`],
                    ['Median', `${gpu.med.toFixed(2)} ms`, `${(1000 / gpu.med).toFixed(0)} fps`],
                    ['Best', `${gpu.min.toFixed(2)} ms`, `${(1000 / gpu.min).toFixed(0)} fps`],
                    ['Worst', `${gpu.max.toFixed(2)} ms`, `${(1000 / gpu.max).toFixed(0)} fps`],
                  ]}
                />
                <KV k="Samples" v={gpu.n.toLocaleString()} />
                {Object.entries(stats.locs).map(([loc, samps]) => {
                  const avg = samps.reduce((a, b) => a + b, 0) / samps.length;
                  return <KV key={loc} k={`${loc} (${samps.length} cams)`} v={`${avg.toFixed(2)} ms · ${(1000 / avg).toFixed(0)} fps`} />;
                })}
              </div>
            </Card>
          )}
        </div>

        <div className="flex flex-col gap-4">
          <Card title="Log Level Distribution">
            <div className="flex items-center gap-4">
              <svg viewBox="0 0 100 100" width={92} height={92} className="shrink-0">
                {arcs.length === 1 ? (
                  <circle cx="50" cy="50" r="44" fill={levelSvgColor[arcs[0].l]} stroke="rgba(15,23,42,0.7)" strokeWidth="1" />
                ) : (
                  arcs.map((d, i) => (
                    <path
                      key={i}
                      d={`M50,50 L${d.x1.toFixed(2)},${d.y1.toFixed(2)} A44,44 0 ${d.large},1 ${d.x2.toFixed(
                        2
                      )},${d.y2.toFixed(2)} Z`}
                      fill={levelSvgColor[d.l]}
                      stroke="rgba(15,23,42,0.7)"
                      strokeWidth="1"
                    />
                  ))
                )}
              </svg>
              <div className="flex flex-col gap-1.5">
                {pieData.map((d) => (
                  <div key={d.l} className="flex items-center gap-2 text-sm">
                    <span className={`${levelTextClass[d.l]} w-24`}>{d.l}</span>
                    <span className="text-slate-400 tabular-nums w-16 text-right">{d.v.toLocaleString()}</span>
                    <span className="text-slate-600 tabular-nums">
                      ({pTot > 0 ? ((d.v / pTot) * 100).toFixed(1) : '0.0'}%)
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </Card>

          <Card title="Top Categories">
            <div className="max-h-72 overflow-y-auto pr-1">
              {cats.slice(0, 30).map((c) => (
                <div key={c.name} className="flex items-center gap-2 text-sm py-1">
                  <span className="text-slate-500 w-40 truncate" title={c.name}>
                    {c.name}
                  </span>
                  <div className="flex-1 h-2 rounded bg-slate-800 overflow-hidden">
                    <div
                      className="h-full bg-sky-500/40"
                      style={{ width: `${cats.length > 0 ? (c.lineCount / cats[0].lineCount) * 100 : 0}%` }}
                    />
                  </div>
                  <span className="text-slate-200 tabular-nums w-14 text-right">{c.lineCount.toLocaleString()}</span>
                </div>
              ))}
            </div>
          </Card>

          <Card title="Session">
            <div className="flex flex-col gap-1.5">
              <KV k="Engine" v={stats.engine} />
              <KV k="Net Mode" v={stats.netMode} />
              <KV k="Total Lines" v={total.toLocaleString()} />
              {stats.cmd && <KV k="Command Line" v={stats.cmd.length > 120 ? `${stats.cmd.slice(0, 120)}…` : stats.cmd} />}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

