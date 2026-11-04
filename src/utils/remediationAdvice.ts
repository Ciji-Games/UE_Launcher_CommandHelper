import type { FixSuggestion, Level } from '../types/traceAnalyzer';

export interface RemediationAdvice {
  title: string;
  fixes: FixSuggestion[];
  verify: string;
  caveats?: string[];
  matchConfidence?: Level;
  fixLikelihood?: Level;
}

export function getRemediationAdvice(
  ruleId: string,
  timerName: string,
  threadRole: string = 'game',
  scale: 'spike' | 'sustained' = 'spike'
): RemediationAdvice {
  const tLower = timerName.toLowerCase();
  const isGpu = threadRole === 'gpu' || ruleId === 'gpu-bound';

  // 1. GPU Bottlenecks
  if (isGpu || ruleId === 'gpu-bound') {
    if (tLower.includes('fxsystem') || tLower.includes('niagara') || tLower.includes('particle') || tLower.includes('cascade')) {
      return {
        title: `GPU Particle & Niagara Simulation: ${timerName}`,
        fixes: [
          {
            text: 'Reduce active Niagara emitter particle counts, clamp max spawn bursts, and enable GPU particle simulation budgeting (fx.Niagara.GPUComputeBudget).',
            effort: 'medium',
            cvarsOrApis: ['fx.Niagara.GPUComputeBudget', 'fx.MaxNiagaraGPUParticles'],
          },
          {
            text: 'Set distance-based culling thresholds or disable offscreen simulation on non-essential particle emitters.',
            effort: 'low',
          },
          {
            text: 'Convert CPU Niagara systems to GPU compute emitters or reduce collision complexity on GPU particles.',
            effort: 'medium',
          },
        ],
        verify: 'Profile with stat Niagara or toggle particle systems off to confirm GPU frame time reduction.',
        fixLikelihood: 'high',
        matchConfidence: 'high',
      };
    }

    if (tLower.includes('lumen') || tLower.includes('indirectlighting') || tLower.includes('lightgrid')) {
      return {
        title: `Lumen Global Illumination & Reflections: ${timerName}`,
        fixes: [
          {
            text: 'Lower Lumen Global Illumination and Reflection scalability presets in Project Settings or adjust resolution scale bias.',
            effort: 'medium',
            cvarsOrApis: ['r.Lumen.DiffuseIndirect.Allow', 'r.Lumen.Reflections.Allow'],
          },
          {
            text: 'Reduce the rate of active Lumen surface cache updates and clamp max reflection ray-tracing distance.',
            effort: 'medium',
          },
          {
            text: 'Enable Software Ray Tracing or lower Lumen detail trace distance for complex geometry.',
            effort: 'low',
          },
        ],
        verify: 'Toggle Lumen quality presets and verify GPU pass duration decreases.',
        fixLikelihood: 'high',
        matchConfidence: 'high',
      };
    }

    if (tLower.includes('shadow') || tLower.includes('vsm') || tLower.includes('virtualshadowmap')) {
      return {
        title: `Shadow Depths & Virtual Shadow Maps: ${timerName}`,
        fixes: [
          {
            text: 'Optimize Virtual Shadow Map (VSM) resolution bias or clamp local shadow-casting lights.',
            effort: 'medium',
            cvarsOrApis: ['r.Shadow.Virtual.ResolutionLodBias', 'r.Shadow.Virtual.MaxPhysicalPages'],
          },
          {
            text: 'Disable dynamic shadow casting on small decorative props and foliage instances.',
            effort: 'low',
          },
          {
            text: 'Enable shadow map caching for static lights and distant geometry.',
            effort: 'medium',
          },
        ],
        verify: 'Adjust r.Shadow.Virtual.ResolutionLodBias and verify GPU shadow depth pass time decreases.',
        fixLikelihood: 'high',
        matchConfidence: 'high',
      };
    }

    if (tLower.includes('nanite') || tLower.includes('rasterize')) {
      return {
        title: `Nanite Geometry Rasterization: ${timerName}`,
        fixes: [
          {
            text: 'Adjust Nanite edge resolution bias (r.Nanite.MaxPixelsPerEdge) or audit over-dense mesh clusters.',
            effort: 'low',
            cvarsOrApis: ['r.Nanite.MaxPixelsPerEdge'],
          },
          {
            text: 'Ensure materials on Nanite meshes do not use expensive programmable rasterizer features (e.g. World Position Offset or Masked opacity) where unnecessary.',
            effort: 'medium',
            cvarsOrApis: ['r.Nanite.WPO'],
          },
        ],
        verify: 'Audit with Nanite visualization modes and check rasterization pass time.',
        fixLikelihood: 'high',
        matchConfidence: 'high',
      };
    }

    if (tLower.includes('postprocess') || tLower.includes('tsr') || tLower.includes('dlss') || tLower.includes('tonemap')) {
      return {
        title: `Post-Processing & Super Resolution: ${timerName}`,
        fixes: [
          {
            text: 'Tune Dynamic Resolution / Temporal Super Resolution screen percentage (r.ScreenPercentage).',
            effort: 'low',
            cvarsOrApis: ['r.ScreenPercentage'],
          },
          {
            text: 'Lower Bloom, Motion Blur, or Depth of Field scalability quality in Post Process Volumes.',
            effort: 'low',
          },
        ],
        verify: 'Adjust r.ScreenPercentage and confirm GPU frame duration drops.',
        fixLikelihood: 'high',
        matchConfidence: 'high',
      };
    }

    return {
      title: `GPU Rendering Bottleneck: ${timerName}`,
      fixes: [
        {
          text: 'Enable or tune Dynamic Resolution / Temporal Super Resolution (r.ScreenPercentage) for your target framerate.',
          effort: 'low',
          cvarsOrApis: ['r.ScreenPercentage'],
        },
        {
          text: 'Optimize Virtual Shadow Map (VSM) resolution bias or clamp local shadow-casting lights.',
          effort: 'medium',
          cvarsOrApis: ['r.Shadow.Virtual.ResolutionLodBias'],
        },
        {
          text: 'Review Lumen Global Illumination and Reflection scalability presets in Project Settings.',
          effort: 'medium',
          cvarsOrApis: ['r.Lumen.DiffuseIndirect.Allow'],
        },
      ],
      verify: 'Adjust r.ScreenPercentage or shadow quality presets and confirm GPU frame duration decreases.',
      fixLikelihood: 'high',
      matchConfidence: 'high',
    };
  }

  // 2. TaskGraph Worker Wait
  if (ruleId === 'taskgraph-wait' || tLower.includes('waitfortask') || tLower.includes('taskgraph')) {
    return {
      title: `TaskGraph Worker Stall: ${timerName}`,
      fixes: [
        {
          text: 'Game Thread is stalled waiting synchronously for TaskGraph worker jobs. Check background async physics, parallel animation evaluation, or asset compilation jobs blocking worker pools.',
          effort: 'medium',
          cvarsOrApis: ['TaskGraph.NumWorkerThreads'],
        },
        {
          text: 'Convert synchronous WaitUntilTasksComplete / GameThreadWaitForTask calls into asynchronous completion callbacks or multi-frame task queues.',
          effort: 'high',
        },
        {
          text: 'Ensure worker jobs do not contend for shared mutexes or heavy memory allocations during the stall.',
          effort: 'low',
        },
      ],
      verify: 'Verify in Unreal Insights Threads channel that Game Thread is no longer blocked in WaitUntilTasksComplete.',
      fixLikelihood: 'high',
      matchConfidence: 'high',
    };
  }

  // 3. Render CPU Bottlenecks
  if (ruleId === 'render-cpu' || threadRole === 'render' || threadRole === 'rhi') {
    return {
      title: `Render Thread CPU Bottleneck: ${timerName}`,
      fixes: [
        {
          text: 'Increase HLOD / mesh LOD distance thresholds to reduce visible primitive counts evaluated during InitViews.',
          effort: 'medium',
        },
        {
          text: 'Merge static meshes into Instanced Static Meshes (ISM / HISM) to reduce CPU draw command generation.',
          effort: 'medium',
        },
        {
          text: 'Enable Nanite for complex static geometry to offload CPU visibility culling and draw command generation to GPU.',
          effort: 'low',
        },
      ],
      verify: 'Profile with stat SceneRendering and verify Mesh Draw Commands and View Visibility times drop.',
      fixLikelihood: 'high',
      matchConfidence: 'high',
    };
  }

  // 4. Garbage Collection
  if (ruleId === 'gc-hitch' || tLower.includes('collectgarbage') || tLower.includes('garbage')) {
    return {
      title: `Garbage Collection Pause: ${timerName}`,
      fixes: [
        {
          text: 'Increase time between incremental purge sweeps (gc.TimeBetweenPurgingPendingKillObjects) or raise GC cluster sizes.',
          effort: 'low',
          cvarsOrApis: ['gc.TimeBetweenPurgingPendingKillObjects', 'gc.MinDesiredObjectsPerSubTask'],
        },
        {
          text: 'Reduce high-frequency UObject spawning and destruction in Blueprints by object pooling.',
          effort: 'medium',
        },
        {
          text: 'Enable incremental reachability analysis (gc.IncrementalBeginDestroyEnabled 1).',
          effort: 'low',
          cvarsOrApis: ['gc.IncrementalBeginDestroyEnabled'],
        },
      ],
      verify: 'Adjust gc.TimeBetweenPurgingPendingKillObjects and confirm GC hitch frequency and duration decrease.',
      fixLikelihood: 'high',
      matchConfidence: 'high',
    };
  }

  // 5. Animation Evaluation
  if (ruleId === 'animation-cpu' || tLower.includes('anim') || tLower.includes('tickpose') || tLower.includes('skeletalmesh')) {
    return {
      title: `Skeletal Animation Evaluation: ${timerName}`,
      fixes: [
        {
          text: 'Enable Update Rate Optimization (URO) on SkeletalMeshComponents to throttle tick rates for distant actors.',
          effort: 'low',
          cvarsOrApis: ['a.URO.Enable'],
        },
        {
          text: 'Enable Animation Budget Allocator (ABA) plugin for crowded scenes with multiple skeletal meshes.',
          effort: 'medium',
        },
        {
          text: "Set 'Visibility Based Anim Tick Option' to 'Only Tick Pose when Rendered' on offscreen meshes.",
          effort: 'low',
        },
      ],
      verify: 'Enable URO and verify that TickPose and RefreshBoneTransforms CPU execution time drops.',
      fixLikelihood: 'high',
      matchConfidence: 'high',
    };
  }

  // 6. Blueprint Tick
  if (ruleId === 'bp-tick' || tLower.includes('ubergraph') || tLower.includes('blueprint') || tLower.startsWith('bp_') || tLower.includes('_c::')) {
    return {
      title: `Blueprint Tick & Script Overhead: ${timerName}`,
      fixes: [
        {
          text: "Disable 'Start with Tick Enabled' on actors that do not require per-frame updates; use event-driven Timers or Delegates instead.",
          effort: 'low',
        },
        {
          text: 'Convert high-frequency Blueprint math and loop logic to C++ functions or native components.',
          effort: 'medium',
        },
        {
          text: 'Set actor tick intervals (e.g. PrimaryActorTick.TickInterval = 0.1) for non-critical gameplay logic.',
          effort: 'low',
        },
      ],
      verify: 'Disable unnecessary actor ticks and verify Blueprint execution time decreases.',
      fixLikelihood: 'high',
      matchConfidence: 'high',
    };
  }

  // 7. Physics Simulation
  if (ruleId === 'physics-cpu' || tLower.includes('chaos') || tLower.includes('phys') || tLower.includes('collision')) {
    return {
      title: `Physics Simulation & Collision Stall: ${timerName}`,
      fixes: [
        {
          text: 'Reduce complex multi-shape collision queries or increase collision channel filter specificity.',
          effort: 'medium',
        },
        {
          text: 'Enable async physics simulation tick (p.Chaos.AsyncPhysics 1) to decouple physics stepping from Game Thread.',
          effort: 'low',
          cvarsOrApis: ['p.Chaos.AsyncPhysics'],
        },
        {
          text: 'Lower max physics sub-step counts and disable physics simulation on distant or sleeping rigid bodies.',
          effort: 'low',
        },
      ],
      verify: 'Profile with stat Chaos or stat Collision to confirm reduced physics step duration.',
      fixLikelihood: 'high',
      matchConfidence: 'high',
    };
  }

  // 8. Slate / UI
  if (ruleId === 'ui-slate-overhead' || tLower.includes('slate') || tLower.includes('wbp_') || tLower.includes('widget') || tLower.includes('umg')) {
    return {
      title: `UI Layout & Slate Rendering Overhead: ${timerName}`,
      fixes: [
        {
          text: 'Wrap complex UMG widget trees in InvalidationBox to cache layout passes and avoid slow-path repainting.',
          effort: 'medium',
        },
        {
          text: 'Avoid property bindings in UMG Designer; update UI text and images via explicit event callbacks.',
          effort: 'low',
        },
        {
          text: 'Set collapsed visibility (Collapsed) instead of Hidden for offscreen or inactive widgets.',
          effort: 'low',
        },
      ],
      verify: 'Wrap widgets in InvalidationBox and confirm PaintSlowPath / Prepass time drops.',
      fixLikelihood: 'high',
      matchConfidence: 'high',
    };
  }

  // 9. Asset Loading & Streaming
  if (ruleId === 'sync-load' || ruleId === 'async-load-finalization' || ruleId === 'level-streaming' || tLower.includes('loadpackage') || tLower.includes('streaming')) {
    return {
      title: `Asset Loading & Streaming Stall: ${timerName}`,
      fixes: [
        {
          text: 'Replace synchronous LoadObject / LoadPackage calls with asynchronous TSoftObjectPtr / AsyncLoad requests.',
          effort: 'medium',
        },
        {
          text: 'Preload shared assets during loading screens before gameplay begins.',
          effort: 'low',
        },
        {
          text: 'Tune World Partition / Level Streaming cell loading radii to spread asset loads across multiple frames.',
          effort: 'medium',
        },
      ],
      verify: 'Verify that Game Thread is no longer blocked on synchronous package serialization.',
      fixLikelihood: 'high',
      matchConfidence: 'high',
    };
  }

  // 10. Default / Fallback
  const defaultTitle =
    scale === 'spike'
      ? `CPU Execution Spike: ${timerName} (${threadRole})`
      : `Sustained Overhead: ${timerName} (${threadRole})`;

  return {
    title: defaultTitle,
    fixes: [
      {
        text: `Optimize ${timerName} algorithm complexity and evaluate moving heavy calculations to async TaskGraph worker threads.`,
        effort: 'medium',
      },
      {
        text: `Profile call stack depth and invocation frequencies for ${timerName} using Unreal Insights to eliminate redundant per-frame calls.`,
        effort: 'low',
      },
    ],
    verify: `Verify in Unreal Insights that ${timerName} duration and call counts decrease proportionally.`,
    fixLikelihood: 'medium',
    matchConfidence: 'medium',
  };
}
