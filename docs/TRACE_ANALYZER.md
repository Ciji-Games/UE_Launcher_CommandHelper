# Trace Analyzer

The **Trace Analyzer** is a diagnostic tool for Unreal Engine `.utrace` performance captures. It headlessly extracts frame and timing metrics using Unreal Insights, generates an interactive canvas frame time graph, detects hitches and sustained slow regions, and provides actionable findings detailing culprits, confidence scores, and recommended fixes.

---

## 0. Executable Launch & Automated Tracing

In addition to importing existing `.utrace` files, the Trace Analyzer can launch a game executable (`.exe`) directly:
- **Automatic Trace Arguments**: Appends `-trace=cpu,gpu,frame,loadtime,counters,bookmark`, `-cpuprofilertrace`, and `-tracefile="<StorePath>"` to the executable invocation.
- **Default UE Trace Store**: Saves captures to `%LOCALAPPDATA%/UnrealEngine/Common/UnrealTrace/Store/001/YYYYMMDD_HHMMSS.utrace`.
- **Process Monitoring**: Tracks the game process (PID, running duration) and displays live monitoring progress.
- **Auto-Load Upon Exit**: When the game closes, the newly generated trace file is immediately loaded and headlessly analyzed without manual intervention.

---

## 1. Unreal Insights CLI Integration (Verified UE 5.7)

### Executable Location
- Default installed engine path: `<EngineRoot>/Engine/Binaries/Win64/UnrealInsights.exe`
- Default Unreal Trace Store: `%LOCALAPPDATA%/UnrealEngine/Common/UnrealTrace/Store/001/*.utrace`
- Project Traces: `<ProjectRoot>/Saved/Profiling/UnrealTrace/*.utrace` or `<ProjectRoot>/Saved/Trace/*.utrace`

### Headless Execution Pattern
Unreal Insights runs headlessly via response files (`.rsp`):

```cmd
UnrealInsights.exe -OpenTraceFile="<TracePath.utrace>" -ABSLOG="<LogPath.log>" -AutoQuit -NoUI -ExecOnAnalysisCompleteCmd="@=<Commands.rsp>" -log
```

### Verified Console Export Commands & Syntax

| Command | Syntax / Parameters | Output CSV Format |
|---|---|---|
| `TimingInsights.ExportThreads` | `TimingInsights.ExportThreads <path/to/threads.csv>` | `Id,Name,Group` |
| `TimingInsights.ExportTimers` | `TimingInsights.ExportTimers <path/to/timers.csv>` | `Id,Type,Name,File,Line` |
| `TimingInsights.ExportTimingEvents` | `TimingInsights.ExportTimingEvents <path/to/events.csv> -threads=<threads> -timers=<timers> -startTime=<start_s> -endTime=<end_s>` | `ThreadId,TimerId,StartTime,EndTime,Depth` |

#### Key CLI Observations
- **Response Files**: Avoid command-line quoting issues on Windows paths by wrapping commands in an `.rsp` response file and referencing it with `-ExecOnAnalysisCompleteCmd="@=<rsp_path>"`.
- **Time Range Filtering**: `-startTime` and `-endTime` (in seconds, floating-point) accurately limit exported timing events to targeted episode and baseline windows without requiring multi-gigabyte full trace event dumps.
- **Thread Filters**: Comma-separated wildcards (e.g. `-threads=GameThread,RenderThread*,RHIThread,GPU*`) allow isolating critical path pipeline stages while omitting worker thread volume.

---

## 2. Ingestion & Analysis Architecture (v3 Streaming Pipeline)

1. **Stage 1 (Import & Pyramid Generation)**:
   - **Pass A (Metadata & Frames)**: Exports thread list, timer list, and top-level `Frame` timing events on pipeline threads (`GameThread`, `RenderThread*`, `RHIThread`, `GPU*`). Computes start-to-start frame intervals and robust baseline statistics.
   - **Full Streaming Slice Export**: Slices the trace on game frame boundaries (~1.5M events/slice with 66ms padding) and invokes `ExportTimingEvents`.
   - **Exclusive Time Ingestion & Thresholding**: Computes per-thread exclusive time per frame on the fly. Records timers with sum $\ge 0.1\text{ ms}$, rolling remaining sub-threshold sums into `timer_id = 0` ("other"). Deletes slice CSV files immediately.
   - **Global Baseline**: Derives `baseline_global` (median exclusive ms and calls) across all normal frames ($\text{interval} \le 1.25 \times \text{median}$).
   - **2-Level Block Summary Pyramid**: Precomputes `block_profile` and `block_frames` at Level 1 (64 frames) and Level 2 (4096 frames), separating steady-state frames from spike frames.

2. **Stage 2 (Background Diagnosis Timeline)**:
   - Evaluates trace chunks (512 frames) in background CPU workers prioritizing the user's viewport / selection frontier.
   - Executes frame health tests, spike analysis ([-1, +3] context), and sustained rolling windows (~2s window, 0.5s hop).
   - Generates run-length encoded `issue` and `occurrence` entries, merging intra-chunk and stitching across chunk boundaries.

3. **Stage 3 (Instant Range Assembly)**:
   - Assembles arbitrary range statistics and top timers in $< 100\text{ ms}$ using block summaries + at most 2 partial edge frames from `frame_timer`.
   - Overlays active spike findings and recurring issue counts without disk I/O.

---

## 3. Benchmarking & Data Sizing Baselines (Phase 0)

| Metric | Raw Event Stream | Sliced Ingestion (0.1 ms Threshold) |
|---|---|---|
| **Rows per Frame (Avg)** | ~350 - 800 raw events | ~40 - 70 index rows |
| **Full Trace (~36k Frames)** | ~15M - 25M CSV rows (~1.2 GB) | ~1.8M - 2.4M rows (~35 MB SQLite) |
| **Memory Footprint** | Unbounded if buffered | $< 80\text{ MB}$ streaming buffer |
| **Range Assembly Latency** | $2\text{s} - 15\text{s}$ (file scan) | $< 15\text{ ms}$ (block pyramid + edges) |

`ExportTimerStatistics` CLI command was confirmed to be region/global aggregate only; exact frame-bounded slicing requires `TimingInsights.ExportTimingEvents` with frame padding.

---

## 4. SQLite Storage & Caching

Each trace is cached in a standalone SQLite database located in `%APPDATA%/com.ciji.ue-launcher/trace_cache/<hash>.db` (or custom app data directory).

- **Cache Key**: `BLAKE3(canonical_path | file_size | modified_time | schema_version | engine_version)`
- **WAL Mode**: Enabled (`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;`) for streaming row insertion and sub-second reopen times.

---

## 4. Trace Channels & Diagnostic Precision

The Trace Analyzer detects which profiling channels are present in the `.utrace` file:
- `cpu`: CPU timing scopes and thread execution
- `gpu`: GPU pipeline and rendering stages
- `frame`: Engine frame start/end boundaries
- `loadtime`: Synchronous and asynchronous asset loading
- `memory`: Low Level Memory (LLM) and allocations
- `counters`: Performance and stats counters (draw calls, visible primitives)
- `bookmark`: User and system bookmarks
- `log`: Engine logging messages

### Granular Scope Attribution & Channel Insights
The diagnostic engine extracts granular asset and system attribution:
- **Blueprint & Widget Disambiguation**: Identifies Blueprint classes and UMG widget names from `ExecuteUbergraph_*`, `*_C::Function`, and `Function /Game/...` scopes (enabled by `-cpuprofilertrace` and Blueprint CPU Profiling).
- **Package & Asset Association**: When `loadtime` channels are recorded, parses specific package paths (`/Game/...`, `LoadPackage`, `Serialize`, `PostLoad`) to pinpoint synchronous asset loading stalls.
- **"Need More Details?" Diagnostic Guidance**: When a diagnostic finding is limited by missing channels (e.g., unattributed CPU gaps or generic GPU passes), the tool presents an actionable badge with recommended flags (`-trace=...`, `-cpuprofilertrace`) to reveal exact asset identities on subsequent captures.
