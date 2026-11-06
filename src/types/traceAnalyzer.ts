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

export interface TraceBookmark {
  id: number;
  name: string;
  startS: number;
  durationS: number;
  threadName?: string;
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
  scale?: 'spike' | 'sustained';
  matchConfidence: Level;
  matchScore: number;
  fixLikelihood: Level;
  /** In ms/frame for sustained findings, or peak spike ms for hitch findings */
  explainsMs: number;
  /** In ms/frame excess gap for sustained findings, or peak frame excess ms for hitch findings */
  ofExcessMs: number;
  evidence: Evidence[];
  fixes: FixSuggestion[];
  verify: string;
  caveats: string[];
  episodeIds: number[];
  occurrences?: Array<{
    occurrenceId: number;
    frameFrom: number;
    frameTo: number;
    startS: number;
    endS: number;
    peakMs: number;
    excessMs: number;
    meanExcessMs: number;
  }>;
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

export interface ThreadMedians {
  gameMs: number;
  renderMs: number;
  gpuMs: number;
  limitingThread: 'gpu' | 'game' | 'render' | 'idle' | string;
}

export interface RangeTopTimer {
  name: string;
  bucket: string;
  subsystem?: string;
  path?: string;
  threadRole: string;
  avgMsPerFrame: number;
  totalMs: number;
  baselineMsPerFrame?: number;
  callCount: number;
  baselineCallsPerFrame?: number;
  isWait?: boolean;
  queue?: string;
  shareOfThreadExcessPct?: number | null;
  shareOfBudgetGapPct?: number | null;
}

export interface RangeWaitEntry {
  thread: string;
  timer: string;
  avgMsPerFrame: number;
}

export interface RangeCategoryBreakdown {
  category: string;
  totalMs: number;
  avgMsPerFrame: number;
  percentage: number;
}

export interface PipelineBalance {
  gpuBoundPct: number;
  gameBoundPct: number;
  renderBoundPct: number;
  idleWaitPct: number;
}

export interface RegimeChange {
  timestampS: number;
  frameIdx: number;
  fromMedianMs: number;
  toMedianMs: number;
  description: string;
  topDeltas: string[];
}

export interface RangeStatisticsResponse {
  startS: number;
  endS: number;
  durationS: number;
  frameCount: number;
  medianMs: number;
  p95Ms: number;
  p99Ms: number;
  minMs: number;
  maxMs: number;
  overBudgetPct: number;
  budgetGapMs: number;
  threadMedians: ThreadMedians;
  topTimers: RangeTopTimer[];
  waitingOn?: RangeWaitEntry[];
  findings?: Finding[];
  regimeChanges?: RegimeChange[];
  sanityFlags?: string[];
  pipelineBalance?: PipelineBalance;
  categories?: RangeCategoryBreakdown[];
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
  | 'launching_game'
  | 'monitoring_game'
  | 'locating_insights'
  | 'exporting_frames'
  | 'ingesting_frames'
  | 'detecting_episodes'
  | 'exporting_windows'
  | 'ingesting_windows'
  | 'analyzing'
  | 'done';

export type ImportStage = 'pass_a' | 'slices' | 'baseline' | 'summaries' | 'done';

export interface ImportProgressPayload {
  stage: ImportStage;
  currentSlice: number;
  totalSlices: number;
  processedFrames: number;
  totalFrames: number;
  elapsedMs: number;
  estimatedRemainingMs?: number | null;
  message: string;
}

export type ChunkStatus = 'queued' | 'running' | 'done';

export interface ChunkState {
  chunkId: number;
  state: ChunkStatus;
  frameFrom: number;
  frameTo: number;
  doneAt?: number | null;
}

export interface Issue {
  issueId: number;
  ruleId: string;
  keyTimerId: number;
  threadRole: string;
  scale: 'spike' | 'sustained';
  firstFrame: number;
  lastFrame: number;
  occurrencesCount: number;
  totalExcessMs: number;
  worstExcessMs: number;
}

export interface Occurrence {
  occurrenceId: number;
  issueId: number;
  chunkId: number;
  frameFrom: number;
  frameTo: number;
  startS: number;
  endS: number;
  peakFrameMs: number;
  meanExcessMs: number;
  sumExcessMs: number;
  confidence: string;
  evidenceJson: string;
}

export interface IssueWithOccurrences {
  issue: Issue;
  occurrences: Occurrence[];
}

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
