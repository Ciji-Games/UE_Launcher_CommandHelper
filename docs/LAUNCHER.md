# Launcher

The Launcher tab is your home base for Unreal Engine projects and engine versions.

![Launcher](../public/assets/launcher.png)

## Settings

A settings icon appears in the navigation bar between the app version and the documentation icon. Click it to open the **Settings** panel, which includes:

### General

- **Start with Windows** — When enabled, the app launches automatically when Windows starts (default: off).

### Engine Management

Manages which engines appear in the Launcher and how they are used:

- **Registry engines** — Engines installed via Epic Games Launcher are detected from the Windows registry. If the registry points to a path that no longer exists, the engine is excluded.
- **Custom engines** — Add engines built from source or installed outside the Epic Launcher. Browse to `UnrealEditor.exe`, optionally auto-detect the version, and provide a display name. Duplicate names are not allowed.
- **Disable engines** — Use the toggle on any engine to hide it from the Launcher. Disabled engines remain visible in Settings so you can re-enable them later.
- **Add Engine** — In the Engine Versions section, an "Add Engine" card opens the Settings panel so you can add a custom engine.

### Engine Association

- **Project engine overrides** — When a project's engine is not found (e.g. "Unknown") or you want to use a different engine, select an override per project. A warning appears if the override's version does not match the project's `.uproject` version.
- **Default engine per version** — When multiple engines share the same major.minor version (e.g. two UE 5.4 installs), choose which one to use by default.

All settings are saved in user preferences.

## Engine Versions

Displays installed Unreal Engine versions (from registry and custom). Each engine appears as a compact card you can click to launch the Unreal Editor. Custom engines show a folder icon badge. An **Add Engine** card opens Settings to add a custom engine.

## Projects

Lists your added `.uproject` projects. Each project card shows:

- **Project name** and engine version
- **C++ indicator** (if applicable)
- **Custom engine icon** (when the project uses an overridden or custom engine)
- **Available maps**
- **Quick actions** (launch, remove)

| Action | Description |
|--------|-------------|
| **Add Project** | Click the "Add Project" button to browse and add a new `.uproject` file. The app will analyze the project and add it to your list. If the engine is not found, the Settings panel opens so you can assign an engine override. |
| **Re-scan** | Use the "Re-scan" button to refresh the project list—removing deleted projects and updating map lists. |

## Pinned Jobs

When you pin a job in the Scheduler tab, it appears here for quick access. Pinned jobs let you run common batch workflows (e.g. HLOD pipeline, Cook + Package) directly from the Launcher without switching tabs.

> [!WARNING]
> Jobs are **blocked from running** if Unreal Editor, Visual Studio, or Rider are already running. Close them first to avoid conflicts.
