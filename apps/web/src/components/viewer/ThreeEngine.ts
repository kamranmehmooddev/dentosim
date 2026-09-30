/**
 * Three.js implementation of the viewer Engine — a DEVELOPMENT / DEBUG viewer.
 * Production end users get the Unity WebGL viewer (UnityEngine) with the same
 * controls; this engine exists so the pipeline output can be inspected and
 * tested without a Unity build.
 */
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { CompareMode, DecodedPart, DecodedTsm2, Engine, HingeAxis, Jaw, ViewPreset } from "@dentosim/viewer-core";

const COLORS = { tooth: 0xf1ead8, attachment: 0x9fb2c8, base: 0xe7e5e4, arch: 0xecc8bf };

interface Slot {
  root: THREE.Group;
  upper: THREE.Group;
  lowerPivot: THREE.Group;
  lower: THREE.Group;
}

export class ThreeEngine implements Engine {
  onToothTap?: Engine["onToothTap"];
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.OrthographicCamera;
  private readonly controls: OrbitControls;
  private readonly slots: [Slot, Slot];
  private readonly meshCache = new Map<string, THREE.Group>();
  private readonly materials: Record<string, THREE.MeshStandardMaterial>;
  private readonly ghost: THREE.MeshStandardMaterial;
  private compare: CompareMode = "single";
  private view: ViewPreset = "front";
  private extent = 70;
  private raf = 0;
  private dirty = true;
  private highlight: string | null = null;
  private showAttachments = true;
  private hinge: HingeAxis | null = null;
  private angle = 0;
  private anim: { from: THREE.Vector3; to: THREE.Vector3; upFrom: THREE.Vector3; upTo: THREE.Vector3; t0: number } | null = null;
  private readonly ro: ResizeObserver;

  constructor(private readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.style.touchAction = "none";
    this.renderer.domElement.setAttribute("data-testid", "viewer-canvas");
    container.appendChild(this.renderer.domElement);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000);
    // lab-style headlight: light travels with the camera
    const head = new THREE.DirectionalLight(0xffffff, 2.2);
    head.position.set(0.2, 0.3, 1);
    this.camera.add(head);
    this.scene.add(this.camera);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8078, 0.9));
    this.materials = {
      tooth: new THREE.MeshStandardMaterial({ color: COLORS.tooth, roughness: 0.32, metalness: 0, side: THREE.DoubleSide }),
      gums: new THREE.MeshStandardMaterial({ color: 0xd98a8f, roughness: 0.55, metalness: 0, side: THREE.DoubleSide }),
      attachment: new THREE.MeshStandardMaterial({ color: COLORS.attachment, roughness: 0.2, metalness: 0.1, side: THREE.DoubleSide }),
      base: new THREE.MeshStandardMaterial({ color: COLORS.base, roughness: 0.8, side: THREE.DoubleSide }),
      arch: new THREE.MeshStandardMaterial({ color: COLORS.arch, roughness: 0.45, side: THREE.DoubleSide }),
    };
    this.ghost = new THREE.MeshStandardMaterial({ color: 0x5b8def, transparent: true, opacity: 0.32, depthWrite: false, side: THREE.DoubleSide });
    const mkSlot = (): Slot => {
      const root = new THREE.Group(), upper = new THREE.Group(), lowerPivot = new THREE.Group(), lower = new THREE.Group();
      lowerPivot.add(lower);
      root.add(upper, lowerPivot);
      this.scene.add(root);
      return { root, upper, lowerPivot, lower };
    };
    this.slots = [mkSlot(), mkSlot()];
    this.slots[1].root.visible = false;
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.zoomToCursor = true;
    this.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    this.controls.addEventListener("change", () => (this.dirty = true));
    this.installTap();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);
    this.resize();
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.tickCamera();
      this.controls.update();
      if (this.dirty) {
        this.renderer.render(this.scene, this.camera);
        this.dirty = false;
      }
    };
    loop();
  }

  private installTap() {
    const el = this.renderer.domElement;
    let down: { x: number; y: number; t: number } | null = null;
    el.addEventListener("pointerdown", (e) => (down = { x: e.clientX, y: e.clientY, t: performance.now() }));
    el.addEventListener("pointerup", (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6 || performance.now() - down.t > 500) return;
      const r = el.getBoundingClientRect();
      const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      const ray = new THREE.Raycaster();
      ray.setFromCamera(ndc, this.camera);
      const hit = ray.intersectObjects([this.slots[0].root], true).find((h) => h.object.visible && (h.object.userData as { kind?: string }).kind === "tooth");
      const u = hit?.object.userData as { jaw: Jaw; toothId: string; fdi?: number } | undefined;
      this.onToothTap?.(u ? { jaw: u.jaw, toothId: u.toothId, ...(u.fdi ? { fdi: u.fdi } : {}) } : null);
    });
  }

  private groupFor(jaw: Jaw, d: DecodedTsm2): THREE.Group {
    const key = `${jaw}:${d.header.stage}`;
    let g = this.meshCache.get(key);
    if (g) return g;
    g = new THREE.Group();
    for (const p of d.parts) g.add(this.meshFor(jaw, p));
    this.meshCache.set(key, g);
    if (this.meshCache.size > 60) {
      const [oldKey, old] = this.meshCache.entries().next().value!;
      old.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      this.meshCache.delete(oldKey);
    }
    return g;
  }

  private meshFor(jaw: Jaw, p: DecodedPart): THREE.Mesh {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(p.positions, 3));
    geo.setAttribute("normal", new THREE.BufferAttribute(p.normals, 3));
    geo.setIndex(new THREE.BufferAttribute(p.triangles, 1));
    geo.computeBoundingSphere();
    const m = new THREE.Mesh(geo, this.materials[p.kind] ?? this.materials.arch);
    m.userData = { jaw, toothId: p.id, fdi: p.fdi, kind: p.kind };
    return m;
  }

  setStage(slot: 0 | 1, stage: Partial<Record<Jaw, DecodedTsm2 | null>>): void {
    const s = this.slots[slot];
    for (const jaw of ["upper", "lower"] as Jaw[]) {
      const target = jaw === "upper" ? s.upper : s.lower;
      target.clear();
      const d = stage[jaw];
      if (!d) continue;
      const g = slot === 0 ? this.groupFor(jaw, d) : this.ghostGroup(jaw, d);
      target.add(g);
    }
    if (slot === 0 && this.lowerScan) s.lower.add(this.lowerScan);
    if (slot === 0 && this.extent === 70) this.fitExtent();
    this.applyAppearance();
    this.layout();
  }

  private ghostGroup(jaw: Jaw, d: DecodedTsm2): THREE.Group {
    const base = this.groupFor(jaw, d);
    const g = new THREE.Group();
    base.children.forEach((c) => {
      const m = c as THREE.Mesh;
      const clone = new THREE.Mesh(m.geometry, m.material);
      clone.userData = { ...m.userData, ghost: true };
      g.add(clone);
    });
    return g;
  }

  private fitExtent() {
    const box = new THREE.Box3().setFromObject(this.slots[0].root);
    if (!box.isEmpty()) this.extent = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z) * 1.15;
  }

  private scanGroup: THREE.Group | null = null;
  private lowerScan: THREE.Group | null = null;
  setScans(scans: Partial<Record<Jaw, DecodedTsm2>> | null): void {
    if (this.scanGroup) this.slots[0].root.remove(this.scanGroup);
    if (this.lowerScan) this.slots[0].lower.remove(this.lowerScan);
    this.scanGroup = this.lowerScan = null;
    if (scans) {
      const mat = new THREE.MeshStandardMaterial({ color: 0x7fa7d9, transparent: true, opacity: 0.35, depthWrite: false, side: THREE.DoubleSide });
      const mk = (jaw: Jaw, d: DecodedTsm2) => {
        const g = new THREE.Group();
        for (const p of d.parts) {
          const m = this.meshFor(jaw, p);
          m.material = mat;
          m.userData = { scan: true };
          m.renderOrder = 3;
          g.add(m);
        }
        return g;
      };
      if (scans.upper) { this.scanGroup = mk("upper", scans.upper); this.slots[0].root.add(this.scanGroup); }
      // the lower scan follows the lower jaw hinge
      if (scans.lower) { this.lowerScan = mk("lower", scans.lower); this.slots[0].lower.add(this.lowerScan); }
    }
    this.dirty = true;
  }

  setCompare(mode: CompareMode): void {
    this.compare = mode;
    this.slots[1].root.visible = mode !== "single";
    this.applyAppearance();
    this.layout();
  }

  /** Positions for compare modes and the two-arch occlusal view (identical scale everywhere). */
  private layout() {
    const [a, b] = this.slots;
    const both = this.view === "both-occlusal";
    for (const s of this.slots) {
      s.upper.rotation.set(both ? -Math.PI / 2 : 0, 0, 0);
      s.lowerPivot.rotation.set(0, 0, 0);
      s.lower.rotation.set(both ? Math.PI / 2 : 0, 0, 0);
      s.upper.position.set(0, both ? this.extent * 0.3 : 0, 0);
      s.lower.position.set(0, both ? -this.extent * 0.3 : 0, 0);
    }
    this.applyHinge();
    const gap = this.extent * 0.95;
    if (this.compare === "side-by-side") {
      // initial on the left, current/final on the right
      b.root.position.set(-gap / 2, 0, 0);
      a.root.position.set(gap / 2, 0, 0);
    } else {
      a.root.position.set(0, 0, 0);
      b.root.position.set(0, 0, 0);
    }
    this.updateFrustum();
    this.dirty = true;
  }

  private updateFrustum() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    const aspect = w / h;
    let half = this.extent / 2;
    if (this.compare === "side-by-side") half *= 1.9;
    if (this.view === "both-occlusal") half *= 1.35;
    const hw = aspect >= 1 ? half * aspect : half, hh = aspect >= 1 ? half : half / aspect;
    Object.assign(this.camera, { left: -hw, right: hw, top: hh, bottom: -hh });
    this.camera.updateProjectionMatrix();
  }

  setView(view: ViewPreset, animate = true): void {
    this.view = view;
    const d = 200;
    const presets: Record<ViewPreset, { pos: [number, number, number]; up: [number, number, number] }> = {
      front: { pos: [0, 0, d], up: [0, 1, 0] },
      right: { pos: [-d, 0, 0], up: [0, 1, 0] },
      left: { pos: [d, 0, 0], up: [0, 1, 0] },
      "upper-occlusal": { pos: [0, -d, 0], up: [0, 0, 1] },
      "lower-occlusal": { pos: [0, d, 0], up: [0, 0, 1] },
      "both-occlusal": { pos: [0, 0, d], up: [0, 1, 0] },
    };
    const p = presets[view];
    this.controls.target.set(0, 0, 0);
    this.camera.zoom = 1;
    const to = new THREE.Vector3(...p.pos), upTo = new THREE.Vector3(...p.up);
    if (animate) this.anim = { from: this.camera.position.clone(), to, upFrom: this.camera.up.clone(), upTo, t0: performance.now() };
    else {
      this.camera.position.copy(to);
      this.camera.up.copy(upTo);
      this.camera.lookAt(0, 0, 0);
    }
    this.camera.updateProjectionMatrix();
    this.layout();
  }

  private tickCamera() {
    if (!this.anim) return;
    const t = Math.min(1, (performance.now() - this.anim.t0) / 350);
    const e = 1 - (1 - t) ** 3;
    // slerp on the sphere keeps the orthographic scale steady
    const from = this.anim.from.clone().normalize(), to = this.anim.to.clone().normalize();
    const dir = from.lerp(to, e);
    if (dir.lengthSq() < 1e-6) dir.copy(to);
    this.camera.position.copy(dir.normalize().multiplyScalar(this.anim.to.length()));
    this.camera.up.copy(this.anim.upFrom.clone().lerp(this.anim.upTo, e).normalize());
    this.camera.lookAt(0, 0, 0);
    this.dirty = true;
    if (t >= 1) this.anim = null;
  }

  setJawOpening(angleRad: number, hinge: HingeAxis): void {
    this.hinge = hinge;
    this.angle = angleRad;
    this.applyHinge();
    this.dirty = true;
  }

  private applyHinge() {
    if (!this.hinge || this.view === "both-occlusal") {
      for (const s of this.slots) { s.lowerPivot.position.set(0, 0, 0); s.lowerPivot.rotation.set(0, 0, 0); }
      if (this.view !== "both-occlusal") for (const s of this.slots) s.lower.position.set(0, 0, 0);
      return;
    }
    const [hx, hy, hz] = this.hinge.point;
    for (const s of this.slots) {
      s.lowerPivot.position.set(hx, hy, hz);
      s.lower.position.set(-hx, -hy, -hz);
      s.lowerPivot.rotation.set(this.angle, 0, 0);
    }
  }

  setAppearance(a: { gumColor: string; showAttachments: boolean; highlightToothId?: string | null }): void {
    this.materials.gums.color.set(a.gumColor);
    this.showAttachments = a.showAttachments;
    this.highlight = a.highlightToothId ?? null;
    this.applyAppearance();
  }

  private applyAppearance() {
    const hl = this.materials.tooth.clone();
    hl.emissive = new THREE.Color(0x1d8fd6);
    hl.emissiveIntensity = 0.35;
    for (const [i, s] of this.slots.entries())
      s.root.traverse((o) => {
        const m = o as THREE.Mesh;
        const u = m.userData as { kind?: string; toothId?: string; ghost?: boolean };
        if (!u.kind) return;
        m.visible = u.kind !== "attachment" || this.showAttachments;
        if (i === 1 && this.compare === "overlay") m.material = this.ghost;
        else if (i === 0 && u.kind === "tooth" && this.highlight && u.toothId === this.highlight) m.material = hl;
        else m.material = this.materials[u.kind] ?? this.materials.arch;
        m.renderOrder = i === 1 && this.compare === "overlay" ? 2 : 0;
      });
    this.dirty = true;
  }

  async screenshot(): Promise<Blob> {
    this.renderer.render(this.scene, this.camera);
    return new Promise((res) => this.renderer.domElement.toBlob((b) => res(b!), "image/png"));
  }

  resize(): void {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.updateFrustum();
    this.dirty = true;
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.controls.dispose();
    for (const g of this.meshCache.values()) g.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
