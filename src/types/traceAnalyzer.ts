export type EpisodeKind = 'hitch' | 'slow_region';
export type BoundBy = 'game' | 'render' | 'rhi' | 'gpu' | 'idle_limited' | 'unattributed';
export type Level = 'high' | 'medium' | 'low';

export interface InsightsExeInfo {
  path?: string;
  exists: boolean;
}

export interface TraceCandidate {
  path: string;
  fileName: string;
  sizeBytes: number;
  modifiedMs: number;
  isCached: boolean;
  source: 'store' | 'project';
}

export interface TraceSummary {
  traceId: string;
  path: string;
  sizeBytes: number;
  durationS: number;
  frameCount: number;
  engineVersion?: string;
  isEditorBuild: boolean;
  medianMs: number;
  p95Ms: number;
  p99Ms: number;
  targetMs: number;
  hitchCount: number;
  slowRegionCount: number;
  verdict: string;
  detectedChannels: string[];
  missingChannels: string[];
}

export interface FramePoint {
  t: number;
  frameMs: number;
  gameMs?: number;
  renderMs?: number;
  gpuMs?: number;
}

export interface FrameBucket {
  t0: number;
  t1: number;
  minMs: number;
  maxMs: number;
  avgMs: number;
  count: number;
}

export interface FrameSeriesResponse {
  isBucketed: boolean;
  buckets: FrameBucket[];
  points: FramePoint[];
}

export interface Episode {
  id: number;
  kind: EpisodeKind;
  startS: number;
  endS: number;
  frameFrom: number;
  frameTo: number;
  peakMs: number;
  medianMs: number;
  boundBy: BoundBy;
  periodicGroup?: number | null;
}

export interface Evidence {
  label: string;
  valueMs?: number;
  baselineMs?: number;
  calls?: number;
  thread?: string;
  note?: string;
}

export interface FixSuggestion {
  text: string;
  effort: Level;
  cvarsOrApis?: string[];
}

export interface ChannelSuggestion {
  badge: string;
  channelFlags: string;
  description: string;
  missingChannels: string[];
}

export interface FindingPayload {
  title: string;
  matchConfidence: Level;
  matchScore: number;
  fixLikelihood: Level;
  explainsMs: number;
  ofExcessMs: number;
  evidence: Evidence[];
  fixes: FixSuggestion[];
  verify: string;
  caveats: string[];
  episodeIds: number[];
  periodS?: number;
  channelSuggestion?: ChannelSuggestion;
}

export interface Finding {
  id: number;
  ruleId: string;
  rank: number;
  matchConfidence: number;
  fixLikelihood: string;
  episodeIds: number[];
  payload: string; // JSON parsed into FindingPayload
  parsedPayload?: FindingPayload;
}

export interface BucketBreakdown {
  bucket: string;
  episodeMs: number;
  baselineMs: number;
}

export interface TimerExcessDetail {
  timerName: string;
  bucket: string;
  episodeExclMs: number;
  baselineMedianMs: number;
  excessMs: number;
  callCount: number;
}

export interface ThreadBusyDetail {
  threadName: string;
  role: string;
  busyMs: number;
  waitMs: number;
}

export interface EpisodeDetailResponse {
  episode: Episode;
  boundBy: string;
  buckets: BucketBreakdown[];
  topTimers: TimerExcessDetail[];
  threads: ThreadBusyDetail[];
}

export type TraceStage =
  | 'locating_insights'
  | 'exporting_frames'
  | 'ingesting_frames'
  | 'detecting_episodes'
  | 'exporting_windows'
  | 'ingesting_windows'
  | 'analyzing'
  | 'done';

export interface TraceProgressPayload {
  stage: TraceStage;
  indeterminate: boolean;
  percent?: number;
  rows?: number;
  bytesRead?: number;
  bytesTotal?: number;
  elapsedMs: number;
  message?: string;
}

export interface AnalysisOptions {
  targetFps: number;
  hitchFactor: number;
  hitchMinExtraMs: number;
  hitchFloorMs: number;
  maxEpisodes: number;
  baselineSamples: number;
  maxWindowRows: number;
}

export interface CacheInfo {
  totalFiles: number;
  totalSizeBytes: number;
  cacheDir: string;
}
