# Trace Analyzer

The **Trace Analyzer** is a diagnostic tool for Unreal Engine `.utrace` performance captures. It headlessly extracts frame and timing metrics using Unreal Insights, generates an interactive canvas frame time graph, detects hitches and sustained slow regions, and provides actionable findings detailing culprits, confidence scores, and recommended fixes.

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

## 2. Two-Pass Loading Strategy

1. **Pass A (Lightweight Metadata & Frames)**:
   - Exports thread list, timer list, and top-level `Frame` timing events on pipeline threads (`GameThread`, `RenderThread*`, `RHIThread`, `GPU*`).
   - Computes start-to-start frame time intervals and immediately displays the `<canvas>` frame time graph.
2. **Pass B (Targeted Window Export)**:
   - Extracts top hitch episodes (up to 15), local baseline normal frames (within ±5 s), and global baseline normal frames.
   - Computes exclusive runtime per timer scope using an interval stack algorithm.
   - Evaluates diagnostic rules and displays ranked findings with quantitative evidence.

---

## 3. SQLite Storage & Caching

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

### "Need More Details?" Diagnostic Guidance
When a diagnostic finding lacks granularity due to missing trace channels (for example, unattributed CPU stalls or generic GPU bottleneck), the tool displays a **"Need more details?"** badge specifying the exact command-line flags (`-trace=...`) and engine settings required to attribute the root cause.
