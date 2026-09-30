/**
 * Viewer state + playback, independent of the rendering engine (Unity WebGL in
 * production, Three.js in development). The React chrome drives a Controller;
 * the Controller drives an Engine.
 */
import type { DecodedTsm2 } from "./tsm2.js";
import type { Jaw, PackageClient } from "./package.js";

export type ViewPreset = "front" | "left" | "right" | "upper-occlusal" | "lower-occlusal" | "both-occlusal";
export type CompareMode = "single" | "side-by-side" | "overlay";
export type Speed = 1 | 2 | 4 | 8;

export interface ViewerState {
  stage: number;
  stageCount: number;
  playing: boolean;
  speed: Speed;
  view: ViewPreset;
  compare: CompareMode;
  showUpper: boolean;
  showLower: boolean;
  jawOpeningMm: number;
  showAttachments: boolean;
  gumColor: string;
  selected: { jaw: Jaw; toothId: string; fdi?: number } | null;
  showScans: boolean;
  hasScans: boolean;
  loading: boolean;
}

/** What an engine must implement. All geometry is in the DentoSim frame (mm). */
export interface Engine {
  /** Show stage data for each jaw (null = hide jaw). `slot` 0 is the main model, 1 the comparison model. */
  setStage(slot: 0 | 1, stage: Partial<Record<Jaw, DecodedTsm2 | null>>): void;
  setCompare(mode: CompareMode): void;
  setView(view: ViewPreset, animate?: boolean): void;
  setJawOpening(angleRad: number, hinge: HingeAxis): void;
  setAppearance(a: { gumColor: string; showAttachments: boolean; highlightToothId?: string | null }): void;
  /** Original patient scans as a translucent overlay (null = hide). */
  setScans(scans: Partial<Record<Jaw, DecodedTsm2>> | null): void;
  screenshot(): Promise<Blob>;
  resize(): void;
  dispose(): void;
  onToothTap?: (hit: { jaw: Jaw; toothId: string; fdi?: number } | null) => void;
}

export interface HingeAxis {
  /** point on the hinge axis (mm) */
  point: [number, number, number];
  /** unit axis direction (patient left → right) */
  axis: [number, number, number];
  /** distance hinge → lower incisal edge (mm), converts opening mm → angle */
  radiusMm: number;
}

export const MAX_OPENING_MM = 20;

/**
 * Hinge behind the last lower molars: axis parallel to X, placed 12 mm behind
 * the most posterior lower tooth and 25 mm above the occlusal plane (an
 * approximation of the condyles — the disclaimer states this is not recorded motion).
 */
export function hingeFor(lower: DecodedTsm2 | null): HingeAxis {
  let minZ = Infinity, maxZ = -Infinity, incisalY = 0;
  if (lower)
    for (const p of lower.parts) {
      if (p.kind !== "tooth" && p.kind !== "arch") continue;
      for (let i = 0; i < p.positions.length; i += 3) {
        const z = p.positions[i + 2];
        if (z < minZ) minZ = z;
        if (z > maxZ) { maxZ = z; incisalY = p.positions[i + 1]; }
      }
    }
  if (!Number.isFinite(minZ)) { minZ = -25; maxZ = 20; }
  const point: [number, number, number] = [0, 25, minZ - 12];
  const radiusMm = Math.hypot(maxZ - point[2], incisalY - point[1]);
  return { point, axis: [1, 0, 0], radiusMm };
}

/** Opening in mm at the incisors → rotation angle (radians) about the hinge. */
export const openingAngle = (mm: number, hinge: HingeAxis) => Math.min(MAX_OPENING_MM, Math.max(0, mm)) / hinge.radiusMm;

export class Controller {
  state: ViewerState;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private hinge: HingeAxis | undefined;
  private listeners = new Set<(s: ViewerState) => void>();
  private cycle: { raf: number } | null = null;
  private loadSeq = 0;

  constructor(
    private readonly engine: Engine,
    private readonly pkg: PackageClient,
    initial: Partial<ViewerState> = {},
  ) {
    this.state = {
      stage: 0, stageCount: pkg.metadata.stageCount, playing: false, speed: 1, view: "front", compare: "single",
      showUpper: true, showLower: true, jawOpeningMm: 0, showAttachments: true, gumColor: "#d98a8f", selected: null, loading: false,
      showScans: false, hasScans: !!(pkg.metadata.case.scans?.upper || pkg.metadata.case.scans?.lower),
      ...initial,
    };
    engine.onToothTap = (hit) => this.selectTooth(hit);
  }

  subscribe(fn: (s: ViewerState) => void): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private update(patch: Partial<ViewerState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  get last(): number {
    return this.state.stageCount - 1;
  }

  async init(): Promise<void> {
    this.engine.setView(this.state.view, false);
    this.applyAppearance();
    await this.showStage(this.state.stage);
  }

  private async stageData(stage: number) {
    const [upper, lower] = await Promise.all(
      (["upper", "lower"] as Jaw[]).map((j) =>
        this.pkg.stagesOf(j) && (j === "upper" ? this.state.showUpper : this.state.showLower) ? this.pkg.stage(j, stage) : Promise.resolve(null),
      ),
    );
    return { upper, lower };
  }

  /** Load and display a stage; later calls win over slower earlier ones. */
  async showStage(stage: number): Promise<void> {
    const s = Math.max(0, Math.min(this.last, stage));
    const seq = ++this.loadSeq;
    this.update({ stage: s, loading: true });
    const data = await this.stageData(s);
    if (seq !== this.loadSeq) return;
    this.engine.setStage(0, data);
    // comparison slot always shows the initial position
    if (this.state.compare !== "single") this.engine.setStage(1, await this.stageData(0));
    if (!this.hinge && this.pkg.stagesOf("lower")) this.hinge = hingeFor(await this.pkg.stage("lower", 0));
    if (this.hinge) this.engine.setJawOpening(openingAngle(this.state.jawOpeningMm, this.hinge), this.hinge);
    this.pkg.prefetch(s, this.state.playing ? 2 + this.state.speed : 2);
    this.update({ loading: false });
  }

  play(): void {
    if (this.state.stage >= this.last) void this.showStage(0);
    this.update({ playing: true });
    const tick = async () => {
      if (!this.state.playing) return;
      const t0 = performance.now();
      if (this.state.stage >= this.last) {
        this.update({ playing: false });
        return;
      }
      await this.showStage(this.state.stage + 1);
      const interval = 1000 / (2 * this.state.speed); // 2 stages/s at 1×
      this.timer = setTimeout(tick, Math.max(0, interval - (performance.now() - t0)));
    };
    this.timer = setTimeout(tick, 1000 / (2 * this.state.speed));
  }

  pause(): void {
    clearTimeout(this.timer);
    this.update({ playing: false });
  }

  toggle(): void {
    if (this.state.playing) this.pause();
    else this.play();
  }

  next(): void { this.pause(); void this.showStage(this.state.stage + 1); }
  prev(): void { this.pause(); void this.showStage(this.state.stage - 1); }
  first(): void { this.pause(); void this.showStage(0); }
  final(): void { this.pause(); void this.showStage(this.last); }
  seek(stage: number): void { this.pause(); void this.showStage(stage); }
  setSpeed(speed: Speed): void { this.update({ speed }); }

  setView(view: ViewPreset): void {
    const patch: Partial<ViewerState> = { view };
    // occlusal views of one arch hide the other (and close the mouth)
    if (view === "upper-occlusal") Object.assign(patch, { showUpper: true, showLower: false });
    if (view === "lower-occlusal") Object.assign(patch, { showUpper: false, showLower: true });
    if (view === "both-occlusal" || view === "front" || view === "left" || view === "right") Object.assign(patch, { showUpper: true, showLower: true });
    const jawsChanged = patch.showUpper !== this.state.showUpper || patch.showLower !== this.state.showLower;
    this.update(patch);
    this.engine.setView(view, true);
    if (jawsChanged) void this.showStage(this.state.stage);
  }

  setJaws(showUpper: boolean, showLower: boolean): void {
    this.update({ showUpper, showLower });
    void this.showStage(this.state.stage);
  }

  /** Initial vs final side by side (identical scale) or overlaid; "single" = normal playback. */
  async setCompare(compare: CompareMode): Promise<void> {
    this.pause();
    this.update({ compare });
    this.engine.setCompare(compare);
    if (compare === "single") return this.showStage(this.state.stage);
    this.engine.setStage(1, await this.stageData(0));
    await this.showStage(this.last);
  }

  setJawOpening(mm: number): void {
    const v = Math.max(0, Math.min(MAX_OPENING_MM, mm));
    this.update({ jawOpeningMm: v });
    if (this.hinge) this.engine.setJawOpening(openingAngle(v, this.hinge), this.hinge);
  }

  openMouth(): void { this.animateOpening(MAX_OPENING_MM); }
  closeMouth(): void { this.animateOpening(0); }

  private animateOpening(target: number, done?: () => void): void {
    if (this.cycle) cancelAnimationFrame(this.cycle.raf);
    const from = this.state.jawOpeningMm, t0 = performance.now(), dur = 600;
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / dur);
      const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      this.setJawOpening(from + (target - from) * e);
      if (t < 1) this.cycle = { raf: requestAnimationFrame(step) };
      else { this.cycle = null; done?.(); }
    };
    this.cycle = { raf: requestAnimationFrame(step) };
  }

  /** Open → close → open … until another jaw command. */
  cycleMouth(times = 3): void {
    let n = 0;
    const go = () => {
      if (n++ >= times * 2) return;
      this.animateOpening(this.state.jawOpeningMm > MAX_OPENING_MM / 2 ? 0 : MAX_OPENING_MM, go);
    };
    go();
  }

  /** Toggle the original upper/lower scans as an overlay (only when the lab supplied scans). */
  async setShowScans(show: boolean): Promise<void> {
    this.update({ showScans: show && this.state.hasScans });
    if (!this.state.showScans) return this.engine.setScans(null);
    const [upper, lower] = await Promise.all([this.pkg.scan("upper"), this.pkg.scan("lower")]);
    this.engine.setScans({ ...(upper ? { upper } : {}), ...(lower ? { lower } : {}) });
  }

  setGumColor(gumColor: string): void {
    this.update({ gumColor });
    this.applyAppearance();
  }

  setAttachments(showAttachments: boolean): void {
    this.update({ showAttachments });
    this.applyAppearance();
  }

  private applyAppearance(): void {
    this.engine.setAppearance({ gumColor: this.state.gumColor, showAttachments: this.state.showAttachments, highlightToothId: this.state.selected?.toothId ?? null });
  }

  selectTooth(sel: ViewerState["selected"]): void {
    this.update({ selected: sel });
    this.applyAppearance();
  }

  screenshot(): Promise<Blob> {
    return this.engine.screenshot();
  }

  movement() {
    const s = this.state.selected;
    return s ? this.pkg.movementOf(s.toothId, s.jaw, this.state.stage) : null;
  }

  /** Keyboard: Space play/pause, ←/→ stages, Home/End first/final, R reset view, +/- speed. */
  handleKey(e: { key: string; preventDefault(): void }): void {
    const speeds: Speed[] = [1, 2, 4, 8];
    const i = speeds.indexOf(this.state.speed);
    switch (e.key) {
      case " ": this.toggle(); break;
      case "ArrowRight": this.next(); break;
      case "ArrowLeft": this.prev(); break;
      case "Home": this.first(); break;
      case "End": this.final(); break;
      case "r": case "R": this.setView(this.state.view); break;
      case "+": case "=": this.setSpeed(speeds[Math.min(3, i + 1)]); break;
      case "-": case "_": this.setSpeed(speeds[Math.max(0, i - 1)]); break;
      default: return;
    }
    e.preventDefault();
  }

  dispose(): void {
    this.pause();
    if (this.cycle) cancelAnimationFrame(this.cycle.raf);
    this.engine.dispose();
    this.listeners.clear();
  }
}
