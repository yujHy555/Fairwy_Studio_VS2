import {
  Scene,
  Mesh,
  VertexData,
  ShaderMaterial,
  Effect,
  Color3,
  Engine
} from '@babylonjs/core';
import { TerrainGrid } from '../terrain/TerrainGrid';

export type LandingRippleStyle = 'fairway' | 'green';

interface ActiveRipple {
  mesh: Mesh;
  mat: ShaderMaterial;
  elapsed: number;
  duration: number;
}

const LANDING_RIPPLE_LAYER_MASK = 0x02000000; // Main camera renders (0x0FFFFFFF); Radar camera (0x0DFFFFFF) skips

/**
 * Triple-AAA Next-Gen Digital Flow & Release Concentric Landing Ring Effect.
 * Renders a terrain-conforming holographic telemetry ripple directly at the ball's
 * exact first-bounce impact point (Fairway Drives & Approach Shots to the Green),
 * with a digital flow-in lock-on, outward release shockwaves, and a smooth 5-second fade-out.
 */
export class LandingRippleEffect {
  private scene: Scene;
  private terrain: TerrainGrid;
  private activeRipples: ActiveRipple[] = [];
  private static shaderRegistered = false;

  constructor(scene: Scene, terrain: TerrainGrid) {
    this.scene = scene;
    this.terrain = terrain;
    LandingRippleEffect.ensureShaderRegistered();

    this.scene.onBeforeRenderObservable.add(() => {
      if (this.activeRipples.length === 0) return;
      const dt = Math.min(0.05, this.scene.getEngine().getDeltaTime() / 1000);
      this.update(dt);
    });
  }

  private static ensureShaderRegistered() {
    if (LandingRippleEffect.shaderRegistered) return;
    LandingRippleEffect.shaderRegistered = true;

    Effect.ShadersStore['landingRippleVertexShader'] = `
      precision highp float;
      attribute vec3 position;
      attribute vec2 uv;
      uniform mat4 worldViewProjection;
      varying vec2 vUV;
      void main(void) {
        vUV = uv;
        gl_Position = worldViewProjection * vec4(position, 1.0);
      }
    `;

    Effect.ShadersStore['landingRippleFragmentShader'] = `
      precision highp float;
      varying vec2 vUV;
      uniform float uTime;
      uniform float uDuration;
      uniform vec3 uColorPrimary;
      uniform vec3 uColorAccent;

      float ringBand(float r, float radius, float width) {
        float d = abs(r - radius);
        return exp(-pow(d / max(0.001, width), 2.0));
      }

      void main(void) {
        vec2 p = vUV * 2.0 - 1.0;
        float r = length(p);
        if (r > 1.0) discard;

        float angle = atan(p.y, p.x); // -PI..PI
        float normAngle = (angle + 3.14159265) / 6.28318530;

        float t = uTime;
        float lifeFrac = clamp(t / max(0.1, uDuration), 0.0, 1.0);

        // Phase 1: Digital Flow-In (0.0s -> 0.65s) - radial sweep + angular trace
        float flowIn = smoothstep(0.0, 0.55, t);
        float sweepRadius = smoothstep(0.0, 0.62, t) * 1.05;
        float sweepMask = smoothstep(sweepRadius + 0.08, sweepRadius - 0.06, r);

        // Phase 3: Smooth Digital Release Fade-Out (3.4s -> 5.0s)
        float fadeOutT = clamp((t - 3.4) / max(0.1, uDuration - 3.4), 0.0, 1.0);
        float fadeOut = 1.0 - fadeOutT * fadeOutT * fadeOutT * (fadeOutT * (fadeOutT * 6.0 - 15.0) + 10.0);

        // Subtle outward expansion during release fade
        float expand = 1.0 + fadeOutT * 0.14;
        float re = r / expand;

        // 1. Center Impact Flash & Precision Pinpoint Core
        float impactFlash = exp(-t * 4.8) * exp(-r * r * 14.0) * 1.65;
        float centerDot = smoothstep(0.065, 0.02, re) * flowIn * 0.95;

        // 2. Inner Solid Telemetry Ring (r = 0.24)
        float innerDraw = smoothstep(0.06, 0.34, t);
        float innerRing = ringBand(re, 0.24, 0.016) * innerDraw;

        // 3. Middle Segmented Rotating Digital Arc Ring (r = 0.52)
        float midDraw = smoothstep(0.16, 0.48, t);
        float rotA = angle - t * 0.85;
        float dashPattern = smoothstep(0.12, 0.35, sin(rotA * 18.0));
        float midRing = ringBand(re, 0.52, 0.020) * (0.35 + 0.65 * dashPattern) * midDraw;

        // 4. Outer Precision Halo Ring with 4 Cardinal Lock-On Brackets (r = 0.80)
        float outerDraw = smoothstep(0.28, 0.62, t);
        float rotB = angle + t * 0.32;
        float bracketMask = smoothstep(0.55, 0.82, abs(cos(rotB * 2.0)));
        float outerRing = ringBand(re, 0.80, 0.014) * (0.42 + 0.58 * bracketMask) * outerDraw;

        // 5. Continuous Outward "Digital Release" Shockwave Pulses
        float pulsePhase1 = fract(t * 0.72);
        float pulseR1 = pulsePhase1 * 0.96;
        float pulseW1 = ringBand(r, pulseR1, 0.032) * (1.0 - pulsePhase1) * smoothstep(0.0, 0.12, pulsePhase1);

        float pulsePhase2 = fract(t * 0.72 + 0.5);
        float pulseR2 = pulsePhase2 * 0.96;
        float pulseW2 = ringBand(r, pulseR2, 0.026) * (1.0 - pulsePhase2) * smoothstep(0.0, 0.12, pulsePhase2) * 0.7;

        // Subtle holographic radial grid shimmer inside the ring field
        float shimmer = (0.5 + 0.5 * sin(r * 42.0 - t * 5.0)) * smoothstep(0.86, 0.12, re) * 0.09 * flowIn;

        // Edge feather so quad boundary is 100% invisible
        float edgeMask = smoothstep(1.0, 0.86, r);

        float primaryEnergy = (innerRing * 1.15 + outerRing * 0.95 + pulseW1 * 0.85 + pulseW2 * 0.65 + shimmer) * sweepMask;
        float accentEnergy = (impactFlash + centerDot * 1.1 + midRing * 1.05 + innerRing * 0.45);

        vec3 col = uColorPrimary * primaryEnergy + uColorAccent * accentEnergy;
        float alpha = clamp((primaryEnergy + accentEnergy) * 0.82, 0.0, 1.0) * fadeOut * edgeMask;

        if (alpha < 0.004) discard;
        gl_FragColor = vec4(col * alpha, alpha);
      }
    `;
  }

  public spawn(worldX: number, worldZ: number, style: LandingRippleStyle) {
    // Keep scene ultra-clean: at most 2 concurrent ripples
    while (this.activeRipples.length >= 2) {
      const oldest = this.activeRipples.shift()!;
      oldest.mesh.dispose();
      oldest.mat.dispose();
    }

    const size = style === 'fairway' ? 7.2 : 5.4;
    const half = size * 0.5;
    const segs = 16;
    const cols = segs + 1;
    const positions = new Float32Array(cols * cols * 3);
    const uvs = new Float32Array(cols * cols * 2);
    const indices: number[] = [];

    for (let iz = 0; iz <= segs; iz++) {
      const vz = iz / segs;
      const wz = worldZ - half + vz * size;
      for (let ix = 0; ix <= segs; ix++) {
        const vx = ix / segs;
        const wx = worldX - half + vx * size;
        const wy = this.terrain.getElevation(wx, wz) + 0.045;
        const vIdx = iz * cols + ix;
        positions[vIdx * 3] = wx;
        positions[vIdx * 3 + 1] = wy;
        positions[vIdx * 3 + 2] = wz;
        uvs[vIdx * 2] = vx;
        uvs[vIdx * 2 + 1] = vz;
      }
    }

    for (let iz = 0; iz < segs; iz++) {
      for (let ix = 0; ix < segs; ix++) {
        const i00 = iz * cols + ix;
        const i10 = i00 + 1;
        const i01 = i00 + cols;
        const i11 = i01 + 1;
        indices.push(i00, i10, i11, i00, i11, i01);
      }
    }

    const mesh = new Mesh(`cup_landingRipple_${Date.now()}`, this.scene);
    const vd = new VertexData();
    vd.positions = positions;
    vd.uvs = uvs;
    vd.indices = indices;
    vd.applyToMesh(mesh);

    const mat = new ShaderMaterial(
      `landingRippleMat_${Date.now()}`,
      this.scene,
      { vertex: 'landingRipple', fragment: 'landingRipple' },
      {
        attributes: ['position', 'uv'],
        uniforms: ['worldViewProjection', 'uTime', 'uDuration', 'uColorPrimary', 'uColorAccent'],
        needAlphaBlending: true
      }
    );

    const duration = 5.0;
    mat.setFloat('uTime', 0.0);
    mat.setFloat('uDuration', duration);
    if (style === 'fairway') {
      // Electric Emerald-Cyan broadcast drive palette
      mat.setColor3('uColorPrimary', new Color3(0.16, 0.92, 0.72));
      mat.setColor3('uColorAccent', new Color3(0.32, 0.88, 1.0));
    } else {
      // Championship Gold-Cyan green approach palette
      mat.setColor3('uColorPrimary', new Color3(0.22, 0.92, 1.0));
      mat.setColor3('uColorAccent', new Color3(1.0, 0.88, 0.30));
    }
    mat.alphaMode = Engine.ALPHA_ADD;
    mat.backFaceCulling = false;
    mat.disableDepthWrite = true;
    mat.zOffset = -3;

    mesh.material = mat;
    mesh.isPickable = false;
    mesh.receiveShadows = false;
    mesh.layerMask = LANDING_RIPPLE_LAYER_MASK;
    mesh.renderingGroupId = 1;
    mesh.freezeWorldMatrix();

    this.activeRipples.push({
      mesh,
      mat,
      elapsed: 0,
      duration
    });
  }

  private update(dt: number) {
    for (let i = this.activeRipples.length - 1; i >= 0; i--) {
      const r = this.activeRipples[i];
      r.elapsed += dt;
      if (r.elapsed >= r.duration) {
        r.mesh.dispose();
        r.mat.dispose();
        this.activeRipples.splice(i, 1);
      } else {
        r.mat.setFloat('uTime', r.elapsed);
      }
    }
  }

  public clear() {
    for (const r of this.activeRipples) {
      r.mesh.dispose();
      r.mat.dispose();
    }
    this.activeRipples = [];
  }
}
