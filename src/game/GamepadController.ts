export interface GamepadHudState {
  connected: boolean;
  padName: string;
  btnA: boolean;
  btnB: boolean;
  btnX: boolean;
  btnY: boolean;
  btnLB: boolean;
  btnRB: boolean;
  btnLT: boolean;
  btnRT: boolean;
  btnSelect: boolean;
  btnStart: boolean;
  dpadUp: boolean;
  dpadDown: boolean;
  dpadLeft: boolean;
  dpadRight: boolean;
  leftStickX: number;
  leftStickY: number;
  rightStickX: number;
  rightStickY: number;
}

export interface GamepadCallbacks {
  onSwingTrigger?: () => void;
  onAimAdjust?: (deltaDeg: number) => void;
  onCameraOrbit?: (deltaYaw: number, deltaPitch: number) => void;
  onClubChange?: (direction: 1 | -1) => void;
  onToggleCameraMode?: () => void;
  onResetAim?: () => void;
  onToggleGreenOverlays?: () => void;
  onToggleMenu?: () => void;
  onHudStateUpdate?: (state: GamepadHudState) => void;
}

export class GamepadController {
  private callbacks: GamepadCallbacks;
  private activeGamepadIndex: number | null = null;
  private prevButtonStates: boolean[] = new Array(20).fill(false);
  private stickDeadzone = 0.16;
  private aimRepeatTimer = 0;
  private smoothedRx = 0;
  private smoothedRy = 0;

  public currentState: GamepadHudState = {
    connected: false,
    padName: 'No Controller',
    btnA: false,
    btnB: false,
    btnX: false,
    btnY: false,
    btnLB: false,
    btnRB: false,
    btnLT: false,
    btnRT: false,
    btnSelect: false,
    btnStart: false,
    dpadUp: false,
    dpadDown: false,
    dpadLeft: false,
    dpadRight: false,
    leftStickX: 0,
    leftStickY: 0,
    rightStickX: 0,
    rightStickY: 0
  };

  constructor(callbacks: GamepadCallbacks = {}) {
    this.callbacks = callbacks;
    this.initEvents();
  }

  private initEvents() {
    window.addEventListener('gamepadconnected', (e: GamepadEvent) => {
      console.log(`🎮 Gamepad connected: ${e.gamepad.id} at index ${e.gamepad.index}`);
      this.activeGamepadIndex = e.gamepad.index;
      this.currentState.connected = true;
      this.currentState.padName = e.gamepad.id.replace(/\s*\([^)]*\)/g, '').trim() || 'Wireless Gamepad';
      this.callbacks.onHudStateUpdate?.(this.currentState);
    });

    window.addEventListener('gamepaddisconnected', (e: GamepadEvent) => {
      console.log(`Gamepad disconnected at index ${e.gamepad.index}`);
      if (this.activeGamepadIndex === e.gamepad.index) {
        this.activeGamepadIndex = null;
        this.smoothedRx = 0;
        this.smoothedRy = 0;
        this.currentState.connected = false;
        this.currentState.padName = 'No Controller';
        this.callbacks.onHudStateUpdate?.(this.currentState);
      }
    });
  }

  public update(dt: number) {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return;

    const gamepads = navigator.getGamepads();
    let pad: Gamepad | null = null;

    if (this.activeGamepadIndex !== null && gamepads[this.activeGamepadIndex]) {
      pad = gamepads[this.activeGamepadIndex];
    } else {
      for (let i = 0; i < gamepads.length; i++) {
        if (gamepads[i]) {
          pad = gamepads[i];
          this.activeGamepadIndex = i;
          break;
        }
      }
    }

    if (!pad) {
      if (this.currentState.connected) {
        this.currentState.connected = false;
        this.callbacks.onHudStateUpdate?.(this.currentState);
      }
      return;
    }

    this.currentState.connected = true;
    this.currentState.padName = pad.id.replace(/\s*\([^)]*\)/g, '').trim() || 'Next-Gen Gamepad';

    // 1. Read Button States
    const getBtn = (idx: number): boolean => {
      const b = pad?.buttons[idx];
      if (!b) return false;
      return typeof b === 'object' ? b.pressed || b.value > 0.4 : b > 0.4;
    };

    const isPressedNow = (idx: number): boolean => {
      const cur = getBtn(idx);
      const prev = this.prevButtonStates[idx] || false;
      return cur && !prev;
    };

    const btnA = getBtn(0);       // South (A / X)
    const btnB = getBtn(1);       // East (B / Circle)
    const btnX = getBtn(2);       // West (X / Square)
    const btnY = getBtn(3);       // North (Y / Triangle)
    const btnLB = getBtn(4);      // Left Bumper
    const btnRB = getBtn(5);      // Right Bumper
    const btnLT = getBtn(6);      // Left Trigger
    const btnRT = getBtn(7);      // Right Trigger
    const btnSelect = getBtn(8);  // Back / View / Share
    const btnStart = getBtn(9);   // Menu / Options / Pause
    const dpadUp = getBtn(12);
    const dpadDown = getBtn(13);
    const dpadLeft = getBtn(14);
    const dpadRight = getBtn(15);

    // 2. Read Stick Axes with strict mapping, radial deadzone & precision response curve
    const shapeStick2D = (x: number, y: number, deadzone: number, exponent: number) => {
      const mag = Math.hypot(x, y);
      if (mag <= deadzone) return { x: 0, y: 0 };
      const norm = Math.min(1, (mag - deadzone) / (1 - deadzone));
      const curved = Math.pow(norm, exponent);
      return { x: (x / mag) * curved, y: (y / mag) * curved };
    };

    const rawLx = pad.axes[0] ?? 0;
    const rawLy = pad.axes[1] ?? 0;
    const rawRx = pad.axes[2] ?? 0;
    const rawRy = (pad.axes.length > 3 ? pad.axes[3] : 0) ?? 0;

    const lStick = shapeStick2D(rawLx, rawLy, this.stickDeadzone, 1.55);
    const rStick = shapeStick2D(rawRx, rawRy, this.stickDeadzone, 2.15);

    const leftStickX = lStick.x;
    const leftStickY = lStick.y;
    const rightStickX = rStick.x;
    const rightStickY = rStick.y;

    // 3. Dispatch Edge-Triggered Actions
    if (isPressedNow(0)) {
      // Button A: Swing Engine 3-click trigger
      this.callbacks.onSwingTrigger?.();
    }

    if (isPressedNow(1)) {
      // Button B: Reset aim to optimal course corridor
      this.callbacks.onResetAim?.();
    }

    if (isPressedNow(2) || isPressedNow(13)) {
      // Button X or D-Pad Down: Club Down
      this.callbacks.onClubChange?.(-1);
    }

    if (isPressedNow(3) || isPressedNow(12)) {
      // Button Y or D-Pad Up: Club Up
      this.callbacks.onClubChange?.(1);
    }

    if (isPressedNow(4) || isPressedNow(5)) {
      // Bumpers: Toggle camera mode (Follow, Orbit, Overhead)
      this.callbacks.onToggleCameraMode?.();
    }

    if (isPressedNow(8)) {
      // Select/Back: Toggle Green Grid & Dots overlay
      this.callbacks.onToggleGreenOverlays?.();
    }

    if (isPressedNow(9)) {
      // Start/Menu: Toggle Main Menu / Pause
      this.callbacks.onToggleMenu?.();
    }

    // 4. Analog Aim Steering (Left Stick & D-Pad)
    let aimDir = 0;
    if (dpadLeft) aimDir -= 1;
    if (dpadRight) aimDir += 1;
    if (leftStickX !== 0) aimDir += leftStickX;

    if (Math.abs(aimDir) > 0.03) {
      // Aim adjustment speed: up to 34 degrees/second with smooth non-linear fine control
      const deltaDeg = aimDir * dt * 34.0;
      this.callbacks.onAimAdjust?.(deltaDeg);
    }

    // 5. Analog Camera Orbit (Right Stick) with exponential damping
    const safeDt = Math.min(0.05, Math.max(0.001, dt));
    const smoothAlpha = 1.0 - Math.exp(-16.0 * safeDt);
    this.smoothedRx += (rightStickX - this.smoothedRx) * smoothAlpha;
    this.smoothedRy += (rightStickY - this.smoothedRy) * smoothAlpha;
    if (Math.abs(rightStickX) === 0 && Math.abs(this.smoothedRx) < 0.002) this.smoothedRx = 0;
    if (Math.abs(rightStickY) === 0 && Math.abs(this.smoothedRy) < 0.002) this.smoothedRy = 0;

    if (Math.abs(this.smoothedRx) > 0.002 || Math.abs(this.smoothedRy) > 0.002) {
      const deltaYaw = this.smoothedRx * dt * 1.45;
      const deltaPitch = -this.smoothedRy * dt * 1.05;
      this.callbacks.onCameraOrbit?.(deltaYaw, deltaPitch);
    }

    // 6. Cache Previous States for Edge Detection
    for (let i = 0; i < 20; i++) {
      this.prevButtonStates[i] = getBtn(i);
    }

    // 7. Update HUD Visual State
    this.currentState = {
      connected: true,
      padName: this.currentState.padName,
      btnA,
      btnB,
      btnX,
      btnY,
      btnLB,
      btnRB,
      btnLT,
      btnRT,
      btnSelect,
      btnStart,
      dpadUp,
      dpadDown,
      dpadLeft,
      dpadRight,
      leftStickX,
      leftStickY,
      rightStickX,
      rightStickY
    };

    this.callbacks.onHudStateUpdate?.(this.currentState);
  }
}
