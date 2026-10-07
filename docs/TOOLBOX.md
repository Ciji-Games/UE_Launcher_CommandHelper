# ToolBox

The ToolBox tab provides a set of standalone tools for common Unreal Engine workflows. Select a tool from the left menu to configure and run it.

![ToolBox](../public/assets/shaderbooster.png)

## Tools

### Shader Booster

Adjust the CPU priority of `ShaderCompileWorker.exe` to speed up shader compilation.

| Option | Description |
|--------|-------------|
| **Priority levels** | Below Normal, Normal, Above Normal, High |
| **Auto-switch** | Applies the selected priority when the worker starts |

### Regenerate Project

Regenerate Visual Studio project files (`.sln`, `.vcxproj`) for C++ projects. Useful after adding/removing plugins or changing engine version.

### Batch Commit

Scan uncommitted files in a Git repository, group them by size, and batch commit with optional Git LFS support. Helps manage large asset commits within LFS size limits.

> [!NOTE]
> **Requirements**: Git, Git LFS (for large files)

### UMap Helper

Run Unreal Editor commands on specific maps:

- HLOD, MiniMap, lighting, foliage, navigation
- Resave actors, rename/duplicate

Select a project and map, then choose the operation.

### Plugin Helper

Build and package plugins from projects with a Plugins folder. Select project, plugin, engine version, and optionally zip the build output.

### UProject Helper

| Action | Description |
|--------|-------------|
| **Cook** | Run UnrealEditor with Cook command |
| **Package** | Build, cook, stage, and package the project (RunUAT BuildCookRun) |
| **Build** | Compile the project |
| **Resave Packages** | Resave packages/assets to update references, fix redirectors, refresh after renaming/moving |

### Movie Render Queue

Queue and run Movie Render Queue jobs from the command line. Configure project, map, sequence, and output settings.

### UE Log Analyzer

Analyze Unreal Engine `.log` / `.txt` files locally with:

- A virtualized log navigator grouped by initialization and frame number
- Fast filters (level, category, full-text)
- A minimap for quickly jumping through warnings/errors
- A **Statistics** view that extracts common session details (hardware, RHI, scalability, FPS/GPU timing when present)

> [!NOTE]
> This tool is **separate from the Output Log** at the bottom of the ToolBox tab and does not modify it.

### Include & module finder

Quickly search and locate `#include` directives and parent `.Build.cs` module dependencies for Unreal Engine core headers, engine plugins, project source code, and project plugins.

| Feature | Description |
|---------|-------------|
| **Auto-deduced Engine Association** | Selecting an active project automatically detects its associated engine version and checks whether the local engine index is ready. |
| **Persistent SQLite Caching** | Scans an engine version once and persists the index in a local SQLite database for instant subsequent searches without memory bloat. |
| **Instant Search & Scope Filtering** | Debounced search matching header file names, include paths, and module names. Filter by `Engine Core`, `Engine Plugins`, `Project Source`, and `Project Plugins`. |
| **Direct Pill Copying** | Click the `#include` or module pill directly to copy the exact directive or module name to clipboard, with quick buttons to open headers in IDE or reveal in File Explorer. |

## Output Log

The collapsible **Output Log** at the bottom shows real-time output from running tools.

> [!TIP]
> The Output Log auto-expands when a tool starts; you can also toggle it manually.
