# Scheduler

The Scheduler tab lets you create **named batch jobs**—sequences of tools that run in order. Ideal for pipelines like:

> Delete HLOD → Build HLOD → Build Lighting → Cook → Package

![Batch Jobs](../public/assets/batchJob.png)

## Creating a Job

1. Click **Create Job**
2. Enter a job name (e.g. "HLOD Pipeline")
3. Add steps from the catalog using the "+ Step" buttons
4. Configure each step's parameters (project, map, options)
5. Reorder steps with ↑/↓ or remove with **Remove**
6. Click **Save**

## Step Types

| Step | Requires Map | Description |
|------|:------------:|-------------|
| Delete HLOD | Yes | Remove existing HLOD |
| Build HLOD | Yes | Build HLOD for selected map |
| Build MiniMap | Yes | Build minimap |
| Build Static Lighting | Yes | Build static lighting |
| Resave Packages | No | Resave packages/assets |
| Resave Actors | Yes | Resave actors in map |
| Foliage Builder | Yes | Run foliage builder |
| Navigation Data Builder | Yes | Build navigation data |
| Rename/Duplicate Map | Yes | Rename or duplicate a map |
| Cook | No | Cook the project |
| Package | No | Build, cook, stage, package |
| Archive Project | No | Archive project files |
| Build | No | Compile the project |
| Regenerate Project | No | Regenerate VS project files |
| Build Plugin | No | Build a plugin |
| Launch Project | No | Launch Unreal Editor |
| Movie Render Queue | Yes | Run MRQ job |

## Running Jobs

| Option | Description |
|--------|-------------|
| **Run** | Execute all steps in sequence. Option to stop on first failure. |
| **Blocking** | Jobs cannot run while Unreal Editor, Visual Studio, or Rider are open. |

> [!WARNING]
> Close Unreal Editor, Visual Studio, and Rider **before** running jobs to avoid conflicts.

## Pinned Jobs

Pin a job (pin icon in the job list) to show it in the **Launcher** tab under "Pinned Jobs". Quick access for frequently used pipelines.
