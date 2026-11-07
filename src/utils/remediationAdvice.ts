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
  if (
    isGpu ||
    ruleId.startsWith('gpu-')
  ) {
    if (
      ruleId === 'gpu-niagara-fx' ||
      tLower.includes('fxsystem') ||
      tLower.includes('niagara') ||
      tLower.includes('particle') ||
      tLower.includes('cascade')
    ) {
      return {
        title: `GPU Particle & Niagara Simulation: ${timerName}`,
        fixes: [
          {
            text: 'Clamp total active GPU particles in the scene and configure particle distance culling.',
            effort: 'low',
            cvarsOrApis: ['fx.MaxNiagaraGPUParticles', 'fx.Niagara.CullDistance'],
          },
          {
            text: 'Enable particle distance culling and reduce emitter spawn rates on distant/off-screen emitters.',
            effort: 'medium',
            cvarsOrApis: ['fx.Niagara.CullDistance'],
          },
          {
            text: 'Audit particle overdraw in Shader Complexity view mode to eliminate dense overlapping translucent sprite quads.',
            effort: 'medium',
          },
        ],
        verify: 'Adjust particle emitter counts/culling and verify that FXSystemPreRender / Niagara GPU pass times decrease.',
        fixLikelihood: 'high',
        matchConfidence: 'high',
      };
    }

    if (
      ruleId === 'gpu-lumen' ||
      tLower.includes('lumen') ||
      tLower.includes('indirectlighting') ||
      tLower.includes('screenprobegather') ||
      tLower.includes('diffuseindirect')
    ) {
      return {
        title: `Lumen Global Illumination & Reflections: ${timerName}`,
        fixes: [
          {
            text: 'Tune Lumen Screen Probe Gather downsample factor (r.Lumen.ScreenProbeGather.DownsampleFactor 16).',
            effort: 'low',
            cvarsOrApis: ['r.Lumen.ScreenProbeGather.DownsampleFactor'],
          },
          {
            text: 'Adjust Lumen Diffuse Indirect and Reflection quality or toggle off in lower scalability tiers.',
            effort: 'low',
            cvarsOrApis: ['r.Lumen.DiffuseIndirect.Allow', 'r.Lumen.Reflections.Allow'],
          },
          {
            text: 'Lower Lumen max trace distance and scene detail in PostProcessVolume / scalability presets.',
            effort: 'medium',
            cvarsOrApis: ['r.Lumen.MaxTraceDistance'],
          },
          {
            text: 'Switch from Hardware Ray Tracing to Software Ray Tracing if high mesh instance counts cause ray tracing BVH update overhead.',
            effort: 'medium',
            cvarsOrApis: ['r.Lumen.HardwareRayTracing'],
          },
        ],
        verify: 'Toggle r.Lumen.DiffuseIndirect.Allow or adjust r.Lumen.ScreenProbeGather.DownsampleFactor and confirm GPU pass times drop.',
        fixLikelihood: 'high',
        matchConfidence: 'high',
      };
    }

    if (
      ruleId === 'gpu-shadow-views' ||
      tLower.includes('cubemap') ||
      tLower.includes('renderdepthforlight')
    ) {
      return {
        title: `Shadow Views & Cubemap Shadow Pass Overhead: ${timerName}`,
        fixes: [
          {
            text: 'Audit local point and spot lights: disable Cast Shadows on non-critical fill and ambient lights.',
            effort: 'low',
          },
          {
            text: 'Enable Virtual Shadow Maps (r.Shadow.Virtual.Enable 1) to replace traditional cubemap shadow projections with clipmap caching.',
            effort: 'low',
            cvarsOrApis: ['r.Shadow.Virtual.Enable'],
          },
          {
            text: 'Enable whole-scene shadow caching (r.Shadow.CacheWholeSceneShadows 1, r.Shadow.CachedShadowsCastFromMovablePrimitives 0).',
            effort: 'low',
            cvarsOrApis: ['r.Shadow.CacheWholeSceneShadows', 'r.Shadow.CachedShadowsCastFromMovablePrimitives'],
          },
          {
            text: 'Increase shadow radius culling threshold (r.Shadow.RadiusThreshold 0.03 to 0.06) to cull distant local light shadows.',
            effort: 'low',
            cvarsOrApis: ['r.Shadow.RadiusThreshold'],
          },
          {
            text: 'Clamp maximum Cascaded/Cubemap shadow resolution (r.Shadow.MaxCSMResolution 1024 or 512).',
            effort: 'low',
            cvarsOrApis: ['r.Shadow.MaxCSMResolution'],
          },
          {
            text: 'Reduce light attenuation radius to prevent large overlapping shadow projection volumes.',
            effort: 'medium',
          },
        ],
        verify: 'Verify in the trace that Nanite::DrawGeometry and ShadowDepths Face calls/frame drop toward baseline (e.g. under 6 views/frame).',
        fixLikelihood: 'high',
        matchConfidence: 'high',
      };
    }

    if (
      ruleId === 'gpu-vsm-shadows' ||
      tLower.includes('shadow') ||
      tLower.includes('vsm') ||
      tLower.includes('virtualshadowmap')
    ) {
      return {
        title: `Shadow Depths & Virtual Shadow Maps: ${timerName}`,
        fixes: [
          {
            text: 'Adjust Virtual Shadow Map resolution LOD bias (r.Shadow.Virtual.ResolutionLodBias -1.0 to 1.0).',
            effort: 'low',
            cvarsOrApis: ['r.Shadow.Virtual.ResolutionLodBias'],
          },
          {
            text: 'Limit maximum physical shadow pages pool size (r.Shadow.Virtual.MaxPhysicalPages 2048).',
            effort: 'low',
            cvarsOrApis: ['r.Shadow.Virtual.MaxPhysicalPages'],
          },
          {
            text: 'Disable dynamic shadow casting on small foliage, prop meshes, or non-critical local lights.',
            effort: 'medium',
          },
          {
            text: 'Enable r.Shadow.Virtual.Cache to preserve static shadow page caching across frames.',
            effort: 'low',
            cvarsOrApis: ['r.Shadow.Virtual.Cache'],
          },
        ],
        verify: 'Adjust r.Shadow.Virtual.ResolutionLodBias and verify that ShadowDepths / VirtualShadowMap pass times drop.',
        fixLikelihood: 'high',
        matchConfidence: 'high',
      };
    }

    if (
      ruleId === 'gpu-nanite' ||
      tLower.includes('nanite') ||
      tLower.includes('rasterize') ||
      tLower.includes('shadebinning')
    ) {
      return {
        title: `Nanite Geometry Rasterization: ${timerName}`,
        fixes: [
          {
            text: 'Tune Nanite max pixels per edge (r.Nanite.MaxPixelsPerEdge 1.0 to 1.5) to reduce triangle and cluster density.',
            effort: 'low',
            cvarsOrApis: ['r.Nanite.MaxPixelsPerEdge'],
          },
          {
            text: 'Disable World Position Offset (WPO) evaluation on distant Nanite instances (r.Nanite.WPO 1, r.Nanite.WPO.MaxDistance).',
            effort: 'medium',
            cvarsOrApis: ['r.Nanite.WPO', 'r.Nanite.WPO.MaxDistance'],
          },
          {
            text: 'Audit programmable raster materials (masked / translucent opacity) on Nanite meshes to minimize shading binning costs.',
            effort: 'medium',
          },
        ],
        verify: 'Adjust r.Nanite.MaxPixelsPerEdge and verify that Nanite rasterization pass duration decreases.',
        fixLikelihood: 'high',
        matchConfidence: 'high',
      };
    }

    if (
      ruleId === 'gpu-basepass' ||
      tLower.includes('basepass') ||
      tLower.includes('prepass') ||
      tLower.includes('earlyz') ||
      tLower.includes('gbuffer')
    ) {
      return {
        title: `BasePass G-Buffer & Material Complexity: ${timerName}`,
        fixes: [
          {
            text: 'Simplify material shader instruction counts and minimize expensive texture sample lookups in heavy shaders.',
            effort: 'medium',
          },
          {
            text: 'Enable Early-Z PrePass (r.EarlyZPass 2) to eliminate masked material pixel overdraw.',
            effort: 'low',
            cvarsOrApis: ['r.EarlyZPass'],
          },
          {
            text: 'Use Masked Material optimization (r.EarlyZPassMovable 1) to avoid redundant pixel shader executions.',
            effort: 'low',
            cvarsOrApis: ['r.EarlyZPassMovable'],
          },
        ],
        verify: 'Test with simplified materials or EarlyZPass enabled and check BasePass pass times.',
        fixLikelihood: 'high',
        matchConfidence: 'high',
      };
    }

    if (
      ruleId === 'gpu-postprocess' ||
      tLower.includes('postprocess') ||
      tLower.includes('temporalsuperresolution') ||
      tLower.includes('tsr') ||
      tLower.includes('taa') ||
      tLower.includes('dlss') ||
      tLower.includes('xess') ||
      tLower.includes('fsr') ||
      tLower.includes('tonemap') ||
      tLower.includes('bloom') ||
      tLower.includes('depthoffield')
    ) {
      return {
        title: `Post-Processing & TSR / Upscaling: ${timerName}`,
        fixes: [
          {
            text: 'Tune Dynamic Resolution / Temporal Super Resolution (r.ScreenPercentage, r.TSR.History.ScreenPercentage).',
            effort: 'low',
            cvarsOrApis: ['r.ScreenPercentage', 'r.TSR.History.ScreenPercentage'],
          },
          {
            text: 'Lower Depth of Field and Motion Blur quality in scalability settings (r.DepthOfFieldQuality 0, r.MotionBlurQuality 0).',
            effort: 'low',
            cvarsOrApis: ['r.DepthOfFieldQuality', 'r.MotionBlurQuality'],
          },
          {
            text: 'Lower Bloom quality or switch to standard Gaussian bloom (r.BloomQuality).',
            effort: 'low',
            cvarsOrApis: ['r.BloomQuality'],
          },
        ],
        verify: 'Adjust r.ScreenPercentage or r.TSR.History.ScreenPercentage and confirm post-processing duration drops.',
        fixLikelihood: 'high',
        matchConfidence: 'high',
      };
    }

    if (
      ruleId === 'gpu-direct-lighting' ||
      tLower.includes('directlighting') ||
      tLower.includes('lightgrid') ||
      tLower.includes('injectlight') ||
      tLower.includes('clusteredshading')
    ) {
      return {
        title: `Direct Lighting & Clustered Shading: ${timerName}`,
        fixes: [
          {
            text: 'Reduce the radius and attenuation distances of overlapping local point and spot lights.',
            effort: 'medium',
          },
          {
            text: 'Limit maximum lights per clustered grid cell (r.LightGrid.MaxLightsPerCell 32).',
            effort: 'low',
            cvarsOrApis: ['r.LightGrid.MaxLightsPerCell'],
          },
          {
            text: 'Disable shadow casting on low-impact fill and accent lights.',
            effort: 'low',
          },
        ],
        verify: 'Toggle off overlapping local lights or clamp light radii and observe DirectLighting duration.',
        fixLikelihood: 'high',
        matchConfidence: 'high',
      };
    }

    if (
      ruleId === 'gpu-translucency' ||
      tLower.includes('translucency') ||
      tLower.includes('translucent')
    ) {
      return {
        title: `Translucent Surface & Overdraw: ${timerName}`,
        fixes: [
          {
            text: 'Enable Separate Translucency Screen Percentage (r.SeparateTranslucencyScreenPercentage 50 to 75).',
            effort: 'low',
            cvarsOrApis: ['r.SeparateTranslucencyScreenPercentage'],
          },
          {
            text: 'Reduce multi-layer translucent material overdraw on particles, smoke, and glass meshes.',
            effort: 'medium',
          },
          {
            text: 'Disable responsive AA and high-cost refraction on non-essential translucent materials.',
            effort: 'low',
          },
        ],
        verify: 'Adjust r.SeparateTranslucencyScreenPercentage and verify translucency pass times decrease.',
        fixLikelihood: 'high',
        matchConfidence: 'high',
      };
    }

    return {
      title: `GPU Rendering Throughput Bottleneck: ${timerName}`,
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
          cvarsOrApis: ['r.Lumen.DiffuseIndirect.Allow', 'r.Lumen.Reflections.Allow'],
        },
        {
          text: 'For heavy particle passes, clamp GPU emitter counts and enable Niagara compute culling.',
          effort: 'medium',
          cvarsOrApis: ['fx.MaxNiagaraGPUParticles', 'fx.Niagara.CullDistance'],
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
