================================================================================
FAIRWAYSTUDIO 2.0 - 3D GOLF COURSE ARCHITECT & TOURNAMENT SIMULATION
Colleague Onboarding Guide, Antigravity Workflow & Technical Overview
================================================================================

Welcome to FairwayStudio 2.0!
This guide explains how to open Google Antigravity, load this project folder,
run the app locally, deploy updates to GitHub & Vercel, and continue developing
using the exact same AI-assisted workflow.


--------------------------------------------------------------------------------
1. GETTING STARTED WITH GOOGLE ANTIGRAVITY
--------------------------------------------------------------------------------

Step 1: Install & Open Antigravity
  - Download and install Google Antigravity (AGY) on your machine.
  - Launch the Antigravity desktop application and sign in with your Google account.

Step 2: Clone or Locate the Project Folder
  - Repository URL:
      https://github.com/yujHy555/Fairwy_Studio_VS2.git
  - Branch:
      main
  - If you do not already have the folder locally, clone it via terminal/Git:
      git clone https://github.com/yujHy555/Fairwy_Studio_VS2.git
    Or use the existing local project folder:
      3D_LOWPOLY_GOLF_COURSE_DESIGNER_vs_02

Step 3: Open the Project Folder in Antigravity
  - In Antigravity, click "Open Folder" (File -> Open Folder) and select the
    project root folder (the folder containing package.json, index.html, and src/).
  - Open the Agent chat panel inside Antigravity.

Step 4: Install Dependencies & Start the Local Dev Server
  - Make sure Node.js (v18+ or v20+) is installed.
  - Install packages once:
      npm install
  - Start the live Vite development server:
      npm run dev
    (Note: On Windows PowerShell if execution policy blocks npm/npx scripts,
     run Vite directly with Node:
      node node_modules/vite/bin/vite.js
    )
  - Open your browser to:
      http://localhost:5173/

Step 5: How to Continue Working with Antigravity (Recommended Workflow)
  - Describe what you want to add, refine, or fix directly in the Antigravity
    chat panel (you can also paste screenshots of visual bugs or UI ideas!).
  - Antigravity will read the relevant TypeScript/GLSL/CSS files, make targeted
    edits, verify with TypeScript + Vite build, and (when you ask) commit and
    push to GitHub.
  - Useful commands to verify code before pushing:
      Typecheck:  node node_modules/typescript/bin/tsc --noEmit
      Prod Build: node node_modules/vite/bin/vite.js build
  - Deploying to Vercel:
      Vercel is connected to the GitHub repository's `main` branch
      (https://github.com/yujHy555/Fairwy_Studio_VS2.git).
      Pushing to `origin main` automatically triggers a live Vercel production
      deployment.
  - Important Guardrails:
      * Always verify you are editing inside this project folder
        (Fairwy_Studio_VS2 / 3D_LOWPOLY_GOLF_COURSE_DESIGNER_vs_02).
      * Never add extra fragment texture samplers to TerrainGrid.ts's
        BunkerGrassExclusionPlugin — WebGL2 has a strict 16-sampler limit per
        fragment shader.
      * Keep evalSingleLayer() lean in TerrainGrid.ts so D3D11/ANGLE shaders
        compile instantly on Windows laptops without stalling the preloader.


--------------------------------------------------------------------------------
2. PROJECT OVERVIEW & KEY FEATURES
--------------------------------------------------------------------------------

FairwayStudio 2.0 is a browser-based, real-time 3D Golf Course Designer and
Playable Golf Simulation built for both desktop workstations and laptops:

  - Play Mode:
      * Realistic aerodynamic golf ball flight (drag, Magnus lift, backspin,
        sidespin, draw/fade shaping, wind vectors, surface-dependent bounce &
        rollout across Fairway, Rough, Green, Tee, Bunker, and Water).
      * Calibrated 12-club bag (Driver ~280m max, 3W, 3H, 5I-9I, PW, SW, LW,
        and Putter) with interactive 3-click/power swing meter and Toptracer
        ball-flight ribbon.
      * Live GPU 3D Aerial Radar view synchronized 1:1 with the 3D terrain,
        complete with RMB panning, scroll-wheel zoom, 15-degree map rotation,
        World-North compass rose, and Course Guide modal.
      * Putting Green slope grid & 4-tier GPU-instanced moving pearl dots.

  - Course Designer Mode:
      * Stamp & transform Championship Tee Boxes, Putting Greens, Organic
        Bunkers (5 harmonic shapes), Water Hazards, and Dogleg Fairways.
      * Real-time 60 FPS GPU terrain sculpting brushes (Raise, Lower, Smooth,
        Flatten) with Undo/Redo history snapshots.
      * Satellite / MapNG heightfield + satellite imagery importer with
        spline-based Feature Tracer (trace arbitrary Fairways, Greens, Bunkers,
        Tee Boxes, and Water directly over real-world satellite courses).
      * Explore-mode draggable Ball & Flag icons on the Radar before Tee/Green
        placement.
      * Per-feature independent PBR material editor (Base Color, Roughness,
        Normal Relief, UV Scale, Mowing Stripes, Collar/Fringe rings, custom
        texture uploads) + 3D Prop Outliner & HDRI Lighting/Atmosphere studio.


--------------------------------------------------------------------------------
3. CORE FRAMEWORKS, LIBRARIES & TECHNOLOGIES
--------------------------------------------------------------------------------

  - Language & Build Tooling:
      * TypeScript (strict static typing across engine, physics, and UI)
      * Vite 8 (instant HMR dev server + Rollup/Rolldown production bundling)
      * Vanilla HTML5 / Modern CSS3 (responsive adaptive HUD for widescreen
        and 1920x1080 / DPI-scaled laptops)

  - 3D Rendering Engine:
      * Babylon.js (@babylonjs/core) on WebGL2
      * PBR (Physically Based Rendering) with ACES Filmic Tonemapping,
        HDRI environment lighting (HDRCubeTexture), and Cascaded Shadow Maps
        (CascadedShadowGenerator)
      * Custom GLSL MaterialPluginBase shader (`BunkerGrassExclusionPlugin` in
        src/terrain/TerrainGrid.ts) for analytical GPU SDF rendering of Tee
        Boxes, Greens, Bunkers, Water, and Traced Spline polygons at infinite
        screen-pixel resolution with zero stair-stepping
      * Dual-scale rotated anti-tiling grass sampling (`sampleSeamlessTurf`)
      * Half-resolution HDR Bloom (`DefaultRenderingPipeline`) & single-pass
        Anamorphic Lens Flare PostProcess

  - Physics & Collision:
      * Havok Physics WebAssembly (@babylonjs/havok) for 3D terrain & tree
        collision
      * Custom RK4 / sub-stepped aerodynamic & turf-interaction physics engine
        (src/physics/Aerodynamics.ts, src/game/Ball.ts, src/game/SwingEngine.ts)

  - Next-Gen Performance Optimizations:
      * Triple-tier adaptive terrain mesh LOD (2m macro Rough blocks, 1m
        standard cells, 0.5m subdivided slope rings with seamless corner/edge
        normals)
      * LUT-only roughness/metallic fragment pass (`evalLayerRoughMet`)
      * Hardware-instanced trees, bushes, rocks, and green slope dots
      * Automatic integrated laptop GPU detection (`src/core/DeviceProfile.ts`)
      * Real-time Adaptive Dynamic Resolution Scaling (DRS) in Play Mode
      * 30 Hz opaque shadow cascade updates on laptop/mobile tiers


--------------------------------------------------------------------------------
4. KEY SOURCE FILES & ARCHITECTURE MAP
--------------------------------------------------------------------------------

  index.html                        App shell & preloader overlay
  public/default_hole.json          Default Demo Hole loaded on boot (local & Vercel)
  public/textures/                  Built-in PBR grass, sand, and water textures
  public/models/                    3D GLB assets (trees, bushes, rubber duck markers)

  src/main.ts                       Main app bootstrap, Babylon scene, cameras,
                                    gizmos, shadows, DRS, and render loop
  src/style.css                     Full UI styling + 1920x1080 adaptive breakpoints
  src/core/
    Constants.ts                    Surface physics properties & golf constants
    DeviceProfile.ts                GPU tier & integrated laptop detection
    HdriPresets.ts                  Sky & lighting presets
    Types.ts                        Shared TypeScript interfaces
  src/terrain/
    TerrainGrid.ts                  Heightfield mesh, LOD builder, analytical SDF
                                    GPU shader plugin, splat/mask & material LUT
    Scenery.ts                      Instanced trees, tee markers, pin/flag, GLB loader
    FeatureLibrary.ts               Preset course features & props catalog
    FeatureTracer.ts                Interactive spline contour tracer
    MapNGImporter.ts                Real-world DEM/heightmap & satellite importer
    GreenContourVisualizer.ts       Green slope grid & GPU-instanced moving dots
  src/game/
    Ball.ts                         Golf ball physics, spin, contact shadow & tracer
    ClubBag.ts                      12-club specifications & distances
    SwingEngine.ts                  Swing meter, shot shaping & wind engine
    CourseManager.ts                Hole management, tee/pin sync & course JSON
    CameraController.ts             Play Mode aim/follow/free & Designer cameras
    AimSystem.ts                    3D aiming arc, chevron & landing target
  src/ui/
    UIController.ts                 HUD, Designer docks, Outliner & Material UI
    OverheadHoleLayout.ts           Live 3D/2D Radar, compass, 15-deg rotate & drag
    CourseGuideModal.ts             Interactive 18-hole Course Guide modal

================================================================================
