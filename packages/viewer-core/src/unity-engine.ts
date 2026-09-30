/**
 * Engine implementation that drives the Unity WebGL viewer.
 *
 * JS → Unity:  unityInstance.SendMessage("DentoSimBridge", <method>, <json>)
 * Unity → JS:  functions in unity/Assets/Plugins/WebGL/DentoSimBridge.jslib call
 *              window.DentoSimBridge.* (copy mesh arrays into the Unity heap,
 *              emit tooth taps, deliver screenshots).
 *
 * Mesh data is decoded once in JS (TSM2 + meshopt) and copied straight into
 * C# arrays, so Unity never parses TSM2 itself.
 */
import type { CompareMode, Engine, HingeAxis, ViewPreset } from "./controls.js";
import type { Jaw } from "./package.js";
import type { DecodedPart, DecodedTsm2 } from "./tsm2.js";

export interface UnityInstance {
  SendMessage(objectName: string, method: string, value?: string | number): void;
  Quit(): Promise<void>;
}

interface BridgeGlobal {
  parts: Map<string, DecodedPart[]>;
  emit(json: string): void;
  screenshot(bytes: Uint8Array): void;
}

declare global {
  interface Window {
    DentoSimBridge?: BridgeGlobal;
  }
}

const OBJ = "DentoSimBridge";

export class UnityEngine implements Engine {
  onToothTap?: Engine["onToothTap"];
  private shot: ((b: Blob) => void) | null = null;

  constructor(private readonly unity: UnityInstance, theme?: { background?: string; gumColor?: string }) {
    window.DentoSimBridge = {
      parts: new Map(),
      emit: (json) => {
        const e = JSON.parse(json) as { type: string; jaw?: Jaw; toothId?: string; fdi?: number };
        if (e.type === "toothTap") this.onToothTap?.(e.toothId ? { jaw: e.jaw!, toothId: e.toothId, ...(e.fdi ? { fdi: e.fdi } : {}) } : null);
      },
      screenshot: (bytes) => {
        this.shot?.(new Blob([bytes.slice()], { type: "image/png" }));
        this.shot = null;
      },
    };
    if (theme) this.send("SetTheme", theme);
  }

  private send(method: string, payload: unknown): void {
    this.unity.SendMessage(OBJ, method, typeof payload === "string" ? payload : JSON.stringify(payload));
  }

  setStage(slot: 0 | 1, stage: Partial<Record<Jaw, DecodedTsm2 | null>>): void {
    const reg = window.DentoSimBridge!.parts;
    for (const jaw of ["upper", "lower"] as Jaw[]) {
      const d = stage[jaw];
      if (!d) {
        this.send("SetStage", { slot, jaw, key: null });
        continue;
      }
      const key = `${jaw}:${d.header.stage ?? 0}`;
      if (!reg.has(key)) reg.set(key, d.parts);
      // keep the registry bounded; Unity caches its own meshes by key
      if (reg.size > 80) reg.delete(reg.keys().next().value!);
      this.send("SetStage", {
        slot, jaw, key,
        parts: d.parts.map((p, index) => ({ index, id: p.id, kind: p.kind, fdi: p.fdi ?? 0, vertexCount: p.vertexCount, indexCount: p.triangleCount * 3 })),
      });
    }
  }

  setScans(scans: Partial<Record<Jaw, DecodedTsm2>> | null): void {
    const reg = window.DentoSimBridge!.parts;
    for (const jaw of ["upper", "lower"] as Jaw[]) {
      const d = scans?.[jaw];
      if (!d) { this.send("SetScan", { jaw, key: null }); continue; }
      const key = `scan:${jaw}`;
      reg.set(key, d.parts);
      this.send("SetScan", { jaw, key, parts: d.parts.map((p, index) => ({ index, id: p.id, kind: p.kind, fdi: 0, vertexCount: p.vertexCount, indexCount: p.triangleCount * 3 })) });
    }
  }

  setCompare(mode: CompareMode): void { this.send("SetCompare", mode); }
  setView(view: ViewPreset, animate = true): void { this.send("SetView", { view, animate }); }
  setJawOpening(angleRad: number, hinge: HingeAxis): void { this.send("SetJawOpening", { angleRad, point: hinge.point, axis: hinge.axis }); }
  setAppearance(a: { gumColor: string; showAttachments: boolean; highlightToothId?: string | null }): void { this.send("SetAppearance", { ...a, highlightToothId: a.highlightToothId ?? "" }); }

  screenshot(): Promise<Blob> {
    return new Promise((resolve) => {
      this.shot = resolve;
      this.send("TakeScreenshot", "");
    });
  }

  resize(): void { /* Unity tracks its canvas size */ }

  dispose(): void {
    void this.unity.Quit();
    delete window.DentoSimBridge;
  }
}
