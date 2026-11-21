import {
  Scene,
  ArcRotateCamera,
  Vector3
} from '@babylonjs/core';
import { Vector3D } from '../core/Types';

export type CameraMode = 'designer' | 'aim' | 'flight' | 'green' | 'scout';

export class CameraController {
  public camera: ArcRotateCamera;
  public mode: CameraMode = 'aim';
  private scene: Scene;

  private targetPosition: Vector3 = Vector3.Zero();
  public isUserDragging: boolean = false;
  private keysPressed: Set<string> = new Set();

  // MMB & RMB hold-to-pan state with proportional distance scaling (Designer Mode only)
  private isPanningDown: boolean = false;
  private lastPanX: number = 0;
  private lastPanY: number = 0;
  private lockedPlayRadius: number = 5.4;
  private playLowerBeta: number = 0.30;
  private playUpperBeta: number = 1.48;
  private designerMinX: number = -40;
  private designerMaxX: number = 260;
  private designerMinZ: number = -40;
  private designerMaxZ: number = 500;
  private designerMaxRadius: number = 1400;
  private isShiftPanning: boolean = false;
  private panStartAlpha: number = 0;
  private panStartBeta: number = 0;

  constructor(scene: Scene, canvas: HTMLCanvasElement) {
    this.scene = scene;

    this.camera = new ArcRotateCamera(
      'fairwayCamera',
      -Math.PI / 2,
      Math.PI / 2.5,
      7.5,
      new Vector3(95, 8.0, 42),
      this.scene
    );
    // Attach control with LMB (button 0) for smooth Orbiting (noPreventDefault=false prevents browser drag interference)
    this.camera.attachControl(canvas, false, false);

    const pointersInput = (this.camera.inputs?.attached?.pointers as any);
    if (pointersInput) {
      // LMB (0) = Pure Orbit; MMB (1) & RMB (2) are handled by our unified screen-plane Pan handler below
      pointersInput.buttons = [0];
      pointersInput.multiTouchPanAndZoom = false;
      pointersInput.multiTouchPanning = true;
    }

    // Near/Far planes tuned for maximum depth buffer precision and unlimited Designer zoom-out visibility
    this.camera.minZ = 0.50;
    this.camera.maxZ = 50000;

    // Remove default keyboard rotation on ArcRotateCamera so we can provide smooth WASD ground-gliding
    this.camera.keysUp = [];
    this.camera.keysDown = [];
    this.camera.keysLeft = [];
    this.camera.keysRight = [];

    // Prevent browser right-click context menu on canvas
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 0 || e.button === 1 || e.button === 2) {
        this.isUserDragging = true;
      }
      // Industry-standard Designer navigation: MMB (1), RMB (2), or Shift+LMB (0) grabs & pans ground plane
      const wantsPan =
        this.mode === 'designer' &&
        (e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey));
      if (wantsPan) {
        this.isPanningDown = true;
        this.isShiftPanning = e.button === 0 && e.shiftKey;
        if (this.isShiftPanning) {
          this.panStartAlpha = this.camera.alpha;
          this.panStartBeta = this.camera.beta;
        }
        this.lastPanX = e.clientX;
        this.lastPanY = e.clientY;
        e.preventDefault();
      }
    });

    window.addEventListener('pointermove', (e) => {
      if (!this.isPanningDown || this.mode !== 'designer') return;
      if (this.isShiftPanning) {
        this.camera.alpha = this.panStartAlpha;
        this.camera.beta = this.panStartBeta;
        this.camera.inertialAlphaOffset = 0;
        this.camera.inertialBetaOffset = 0;
      }
      const dx = e.clientX - this.lastPanX;
      const dy = e.clientY - this.lastPanY;
      this.lastPanX = e.clientX;
      this.lastPanY = e.clientY;

      if (Math.abs(dx) < 0.25 && Math.abs(dy) < 0.25) return;

      const r = Math.max(1.5, this.camera.radius);
      const panScale = r * 0.0022;

      if (e.ctrlKey) {
        this.camera.target.y -= dy * panScale;
        return;
      }

      // Unrestricted ground-plane grab-and-pull panning along camera-relative XZ axes
      const cosAlpha = Math.cos(this.camera.alpha);
      const sinAlpha = Math.sin(this.camera.alpha);
      const grabRightX = sinAlpha;
      const grabRightZ = -cosAlpha;
      const forwardX = -cosAlpha;
      const forwardZ = -sinAlpha;

      const moveX = (dx * grabRightX + dy * forwardX) * panScale;
      const moveZ = (dx * grabRightZ + dy * forwardZ) * panScale;

      this.camera.target.x += moveX;
      this.camera.target.z += moveZ;
    });

    const resetStuckPointers = () => {
      this.isUserDragging = false;
      this.isPanningDown = false;
      this.isShiftPanning = false;
      const pi = (this.camera.inputs?.attached?.pointers as any);
      if (pi) {
        pi._pointA = null;
        pi._pointB = null;
        pi._currentMousePointerIdDown = -1;
      }
    };

    window.addEventListener('pointerup', (e) => {
      if (e.buttons === 0) {
        resetStuckPointers();
      } else if (e.button === 0 || e.button === 1 || e.button === 2) {
        this.isPanningDown = false;
        this.isShiftPanning = false;
      }
    });

    window.addEventListener('pointercancel', () => {
      resetStuckPointers();
    });

    window.addEventListener('blur', () => {
      this.keysPressed.clear();
      resetStuckPointers();
    });

    // Lock zoom wheel in Play Mode so orbit-around-ball stays fixed distance
    canvas.addEventListener('wheel', (e) => {
      if (this.mode !== 'designer') {
        e.preventDefault();
      }
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      this.keysPressed.add(e.code);
    });
    window.addEventListener('keyup', (e) => {
      this.keysPressed.delete(e.code);
    });

    // Unrestricted Designer navigation: full 3D orbit, unlimited zoom range & free ground-plane pan
    this.camera.lowerBetaLimit = 0.01;
    this.camera.upperBetaLimit = Math.PI - 0.05;
    this.camera.lowerRadiusLimit = 0.25;
    this.camera.upperRadiusLimit = null;
    this.camera.wheelDeltaPercentage = 0.04;
    this.camera.wheelPrecision = 0;
    this.camera.inertia = 0.65;
    this.camera.panningInertia = 0;
    this.camera.angularSensibilityX = 650;
    this.camera.angularSensibilityY = 650;
    this.camera.panningSensibility = 0;
    this.camera.panningAxis = new Vector3(1, 0, 1);
  }

  private applyCameraConstraints() {
    if (this.mode === 'designer') {
      this.camera.lowerBetaLimit = 0.01;
      this.camera.upperBetaLimit = Math.PI - 0.05;
      this.camera.lowerRadiusLimit = 0.25;
      this.camera.upperRadiusLimit = null;
      this.camera.wheelDeltaPercentage = 0.04;
      this.camera.wheelPrecision = 0;
      this.camera.panningSensibility = 0;
      return;
    }

    this.isPanningDown = false;
    this.camera.wheelDeltaPercentage = 0;
    this.camera.wheelPrecision = 1e6;

    if (this.mode === 'flight') {
      this.playLowerBeta = 0.15;
      this.playUpperBeta = 1.48;
      this.camera.lowerBetaLimit = this.playLowerBeta;
      this.camera.upperBetaLimit = this.playUpperBeta;
      this.camera.lowerRadiusLimit = 4.5;
      this.camera.upperRadiusLimit = 16.0;
      return;
    }

    if (this.mode === 'green') {
      this.playLowerBeta = 0.35;
      this.playUpperBeta = 1.44;
    } else if (this.mode === 'scout') {
      this.playLowerBeta = 0.12;
      this.playUpperBeta = 1.38;
    } else {
      // 'aim'
      this.playLowerBeta = 0.30;
      this.playUpperBeta = 1.48;
    }

    this.camera.lowerBetaLimit = this.playLowerBeta;
    this.camera.upperBetaLimit = this.playUpperBeta;
    this.camera.lowerRadiusLimit = this.lockedPlayRadius;
    this.camera.upperRadiusLimit = this.lockedPlayRadius;
    this.camera.radius = this.lockedPlayRadius;
    this.camera.inertialRadiusOffset = 0;
  }

  public setMode(mode: CameraMode) {
    const prevMode = this.mode;
    this.mode = mode;

    // Keep LMB (0) for pure Orbit across all modes
    const pointersInput = (this.camera.inputs?.attached?.pointers as any);
    if (pointersInput) {
      pointersInput.buttons = [0];
    }

    if (mode === 'designer') {
      if (prevMode !== 'designer') {
        this.camera.radius = 85;
        this.camera.beta = Math.PI / 3.2;
      }
    } else if (mode === 'aim') {
      // Default start ball view: pulled back 5.4m
      this.lockedPlayRadius = 5.4;
      this.camera.beta = Math.PI / 2.42;
    } else if (mode === 'green') {
      // Intimate, broadcast-style putting camera framing the ball and aiming towards the cup
      this.lockedPlayRadius = 3.6;
      this.camera.beta = Math.PI / 2.58;
    } else if (mode === 'scout') {
      this.lockedPlayRadius = Math.max(20, Math.min(220, this.lockedPlayRadius));
    } else if (mode === 'flight') {
      // Retain current position and smoothly expand framing without 1-frame pop
    }
    this.applyCameraConstraints();
  }

  public snapAimBehindBall(ballPos: Vector3, aimAzimuthDeg: number) {
    this.targetPosition.set(ballPos.x, ballPos.y + 0.42, ballPos.z);
    this.camera.target.copyFrom(this.targetPosition);

    const aimRad = (aimAzimuthDeg * Math.PI) / 180.0;
    this.camera.alpha = -aimRad - Math.PI / 2;
    this.camera.beta = Math.PI / 2.42;
    this.lockedPlayRadius = 5.4;
    if (this.mode !== 'designer') {
      this.applyCameraConstraints();
    } else {
      this.camera.radius = 5.4;
    }
  }

  public setAimHeading(ballPos: Vector3, aimAzimuthDeg: number) {
    this.targetPosition.set(ballPos.x, ballPos.y + 0.42, ballPos.z);
    this.camera.target.copyFrom(this.targetPosition);

    const aimRad = (aimAzimuthDeg * Math.PI) / 180.0;
    const targetAlpha = -aimRad - Math.PI / 2;
    this.camera.alpha += (targetAlpha - this.camera.alpha) * 0.35;
  }

  public updateFlightCamera(ballPos: Vector3, ballVelocity: Vector3D, groundY = 0, hasLanded = false, dt = 0.016) {
    if (this.mode !== 'flight') return;

    // Direct, jitter-free lock to ball position: completely eliminates camera-ball lag and pushing illusions
    this.camera.target.x = ballPos.x;
    this.camera.target.z = ballPos.z;
    if (!hasLanded) {
      this.camera.target.y = ballPos.y + 1.15;
    } else {
      this.camera.target.y = Math.max(groundY + 0.55, ballPos.y + 0.35);
    }

    if (this.isUserDragging) return;

    // Frame-rate-independent damping eliminates cascade shimmer jumps during ball flight
    const kPos = 1 - Math.exp(-5.0 * Math.max(0.001, Math.min(0.05, dt)));
    const kYaw = 1 - Math.exp(-3.8 * Math.max(0.001, Math.min(0.05, dt)));

    const desiredRadius = hasLanded ? 6.2 : 10.5;
    // Flatter broadcast chase angle (~13° downward in flight) keeps the fairway & green ahead in view
    const desiredBeta = hasLanded ? 1.28 : 1.34;
    this.camera.radius += (desiredRadius - this.camera.radius) * kPos;
    this.camera.beta += (desiredBeta - this.camera.beta) * kPos;

    const horizontalSpeed = Math.sqrt(ballVelocity.x * ballVelocity.x + ballVelocity.z * ballVelocity.z);
    if (horizontalSpeed > 1.2) {
      const headingRad = Math.atan2(ballVelocity.x, ballVelocity.z);
      const quarterOffset = hasLanded ? 0.08 : 0.20;
      const targetAlpha = -headingRad - Math.PI / 2 + quarterOffset;

      let alphaDiff = targetAlpha - this.camera.alpha;
      while (alphaDiff < -Math.PI) alphaDiff += Math.PI * 2;
      while (alphaDiff > Math.PI) alphaDiff -= Math.PI * 2;
      this.camera.alpha += alphaDiff * kYaw;
    }
  }

  /**
   * Prevents the camera from ever clipping through the terrain or backdrop hills
   * when zooming/pulling backwards, orbiting low, or panning across valleys and bluffs.
   * Called right before camera rendering so there is zero 1-frame or lerp lag.
   */
  public enforceTerrainCollision(getWorldElevation: (x: number, z: number) => number, dt = 0.016) {
    if (this.mode !== 'designer' && this.mode !== 'flight') {
      this.camera.radius = this.lockedPlayRadius;
      this.camera.inertialRadiusOffset = 0;
    }

    const r = Math.max(0.25, this.camera.radius);

    // 1. Free Designer camera gliding without boundary/terrain clamps or collision pushback
    if (this.mode === 'designer') {
      // Continuously ensure Designer Mode stays 100% unrestricted (no zoom/pitch/bound clamps)
      this.camera.lowerBetaLimit = 0.01;
      this.camera.upperBetaLimit = Math.PI - 0.05;
      this.camera.lowerRadiusLimit = 0.25;
      this.camera.upperRadiusLimit = null;
      this.camera.wheelDeltaPercentage = 0.04;
      this.camera.wheelPrecision = 0;

      if (this.isShiftPanning) {
        this.camera.alpha = this.panStartAlpha;
        this.camera.beta = this.panStartBeta;
        this.camera.inertialAlphaOffset = 0;
        this.camera.inertialBetaOffset = 0;
      }

      const moveSpeed = Math.max(18, r * 0.75) * dt;
      const forwardX = -Math.cos(this.camera.alpha);
      const forwardZ = -Math.sin(this.camera.alpha);
      const rightX = Math.sin(this.camera.alpha);
      const rightZ = -Math.cos(this.camera.alpha);

      let moveX = 0;
      let moveZ = 0;
      if (this.keysPressed.has('KeyW') || this.keysPressed.has('ArrowUp')) {
        moveX += forwardX;
        moveZ += forwardZ;
      }
      if (this.keysPressed.has('KeyS') || this.keysPressed.has('ArrowDown')) {
        moveX -= forwardX;
        moveZ -= forwardZ;
      }
      if (this.keysPressed.has('KeyD') || this.keysPressed.has('ArrowRight')) {
        moveX += rightX;
        moveZ += rightZ;
      }
      if (this.keysPressed.has('KeyA') || this.keysPressed.has('ArrowLeft')) {
        moveX -= rightX;
        moveZ -= rightZ;
      }

      if (moveX !== 0 || moveZ !== 0) {
        const len = Math.sqrt(moveX * moveX + moveZ * moveZ) || 1;
        this.camera.target.x += (moveX / len) * moveSpeed;
        this.camera.target.z += (moveZ / len) * moveSpeed;
      }
      return;
    }

    // 2. Ensure target itself never sinks below local terrain in Play/Flight/Green modes
    const targetGroundY = getWorldElevation(this.camera.target.x, this.camera.target.z);
    if (this.camera.target.y < targetGroundY + 0.25) {
      this.camera.target.y = targetGroundY + 0.25;
    }

    // 4. Exact, zero-lag frustum & ray terrain collision check
    const sinBeta = Math.sin(this.camera.beta);
    const cosAlpha = Math.cos(this.camera.alpha);
    const sinAlpha = Math.sin(this.camera.alpha);

    const camX = this.camera.target.x + r * sinBeta * cosAlpha;
    const camZ = this.camera.target.z + r * sinBeta * sinAlpha;

    // Sample a 5-point safety halo around the camera to protect the near clipping plane on slopes
    const halo = Math.min(2.0, Math.max(0.5, r * 0.05));
    const gCenter = getWorldElevation(camX, camZ);
    const gEast = getWorldElevation(camX + halo, camZ);
    const gWest = getWorldElevation(camX - halo, camZ);
    const gNorth = getWorldElevation(camX, camZ + halo);
    const gSouth = getWorldElevation(camX, camZ - halo);
    const maxCamGround = Math.max(gCenter, gEast, gWest, gNorth, gSouth);

    // Streamlined clearance (~0.40m) allows comfortable low-angle upward tilt without clipping
    const clearance = Math.max(0.40, Math.min(2.2, r * 0.025));
    let requiredCamY = maxCamGround + clearance;

    // Also sample intermediate points along the ray from target to camera so backing behind a ridge/lip never clips
    const rayFractions = [0.45, 0.72, 0.88];
    for (const f of rayFractions) {
      const rx = this.camera.target.x + (camX - this.camera.target.x) * f;
      const rz = this.camera.target.z + (camZ - this.camera.target.z) * f;
      const rg = getWorldElevation(rx, rz) + 0.35;
      const neededCamY = this.camera.target.y + (rg - this.camera.target.y) / f;
      if (neededCamY > requiredCamY) {
        requiredCamY = neededCamY;
      }
    }

    const currentCamY = this.camera.target.y + r * Math.cos(this.camera.beta);

    const dyNeeded = requiredCamY - this.camera.target.y;
    const minBeta = this.playLowerBeta;
    const maxAllowedBeta = this.playUpperBeta;

    if (dyNeeded < r) {
      // Analytical maximum safe beta before camera would sink below terrain
      const cosReq = Math.max(-0.98, Math.min(0.98, dyNeeded / r));
      const safeBeta = Math.max(minBeta, Math.min(maxAllowedBeta, Math.acos(cosReq) - 0.02));

      // Hysteresis prevents per-frame shadow/limit jitter on terrain slopes
      if (Math.abs((this.camera.upperBetaLimit ?? maxAllowedBeta) - safeBeta) > 0.0005) {
        this.camera.upperBetaLimit = safeBeta;
      }
      if (this.camera.beta > safeBeta) {
        this.camera.beta = safeBeta;
      }
    } else {
      if (Math.abs((this.camera.upperBetaLimit ?? minBeta) - minBeta) > 0.0005) {
        this.camera.upperBetaLimit = minBeta;
      }
      this.camera.beta = minBeta;
    }
  }

  public setScoutView(ballPos: Vector3, pinPos: Vector3D) {
    const midX = (ballPos.x + pinPos.x) * 0.5;
    const midZ = (ballPos.z + pinPos.z) * 0.5;
    const dist = Math.sqrt(Math.pow(pinPos.x - ballPos.x, 2) + Math.pow(pinPos.z - ballPos.z, 2));

    this.camera.target.set(midX, 3.0, midZ);
    this.lockedPlayRadius = Math.max(20, Math.min(220, dist * 0.85));
    this.camera.beta = Math.PI / 3.4;

    const heading = Math.atan2(pinPos.x - ballPos.x, pinPos.z - ballPos.z);
    this.camera.alpha = -heading - Math.PI / 2;

    if (this.mode !== 'designer') {
      this.applyCameraConstraints();
    } else {
      this.camera.radius = this.lockedPlayRadius;
    }
  }

  public focusOnPin(pinPos: Vector3D) {
    this.camera.target.set(pinPos.x, Math.max(0.3, pinPos.y + 0.25), pinPos.z);
    this.lockedPlayRadius = 12;
    this.camera.beta = Math.PI / 2.9;
    if (this.mode !== 'designer') {
      this.applyCameraConstraints();
    } else {
      this.camera.radius = 12;
    }
  }

  public setDesignerWorldBounds(
    minX: number,
    maxX: number,
    minZ: number,
    maxZ: number,
    maxRadius: number
  ) {
    this.designerMinX = minX;
    this.designerMaxX = maxX;
    this.designerMinZ = minZ;
    this.designerMaxZ = maxZ;
    this.designerMaxRadius = Math.max(600, maxRadius);
    this.camera.maxZ = Math.max(50000, this.designerMaxRadius * 12);
    if (this.mode === 'designer') {
      this.applyCameraConstraints();
    }
  }

  public ensureDesignerCameraControl(canvas?: HTMLCanvasElement) {
    this.mode = 'designer';
    this.isPanningDown = false;
    this.isShiftPanning = false;
    this.isUserDragging = false;
    this.camera.inertialAlphaOffset = 0;
    this.camera.inertialBetaOffset = 0;
    this.camera.inertialRadiusOffset = 0;
    this.camera.maxZ = Math.max(50000, this.designerMaxRadius * 12);
    if (canvas && !this.camera.inputs?.attachedToElement) {
      this.camera.attachControl(canvas, false, false);
    }
    const pointersInput = (this.camera.inputs?.attached?.pointers as any);
    if (pointersInput) {
      pointersInput.buttons = [0];
      pointersInput._pointA = null;
      pointersInput._pointB = null;
      pointersInput._currentMousePointerIdDown = -1;
    }
    this.applyCameraConstraints();
  }

  public setCourseOverview3D(centerX: number, centerZ: number, spanMeters: number, targetY = 6) {
    if (this.mode === 'designer') {
      this.applyCameraConstraints();
    }
    this.camera.target.set(centerX, targetY, centerZ);
    this.camera.alpha = -Math.PI / 2;
    this.camera.beta = 0.82; // ~47 deg isometric 3D overview matching MapNG preview
    const desiredRadius = Math.max(320, spanMeters * 0.85);
    this.camera.radius = desiredRadius;
    this.camera.inertialAlphaOffset = 0;
    this.camera.inertialBetaOffset = 0;
    this.camera.inertialRadiusOffset = 0;
  }

  public setTopDownView(centerX: number, centerZ: number, spanMeters?: number) {
    if (this.mode === 'designer') {
      this.applyCameraConstraints();
    }
    this.camera.target.set(centerX, 0, centerZ);
    this.camera.alpha = -Math.PI / 2;
    this.camera.beta = 0.05;
    this.camera.radius = spanMeters ? Math.max(160, spanMeters * 0.85) : 160;
    this.camera.inertialAlphaOffset = 0;
    this.camera.inertialBetaOffset = 0;
    this.camera.inertialRadiusOffset = 0;
  }

  /**
   * Frames the camera directly onto a selected object's center of interest in Designer Mode.
   * Sets the camera target to the object so all subsequent LMB orbit rotations pivot smoothly around it.
   */
  public frameOnTarget(targetPos: Vector3, radius?: number) {
    if (this.mode === 'designer') {
      this.applyCameraConstraints();
    }
    this.camera.target.copyFrom(targetPos);
    if (radius !== undefined) {
      this.camera.radius = radius;
    } else {
      this.camera.radius = Math.max(4.0, Math.min(75, this.camera.radius * 0.55));
    }
    this.camera.beta = Math.PI / 3.0;
    this.camera.inertialRadiusOffset = 0;
  }

  public orbitBy(deltaYaw: number, deltaPitch: number) {
    this.camera.alpha += deltaYaw;
    const lo = this.camera.lowerBetaLimit ?? 0.08;
    const hi = this.camera.upperBetaLimit ?? (Math.PI / 2.05);
    this.camera.beta = Math.max(lo, Math.min(hi, this.camera.beta + deltaPitch));
  }
}
