# ToolBox

The ToolBox tab provides a set of standalone tools for common Unreal Engine workflows. Select a tool from the left menu to configure and run it.

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

## Output Log

The collapsible **Output Log** at the bottom shows real-time output from running tools.

> [!TIP]
> The Output Log auto-expands when a tool starts; you can also toggle it manually.
