"use client";

/**
 * Treatment-simulation viewer chrome (React) + engine selection.
 *  - production: Unity WebGL build (UNITY_BUILD_URL) through the JS bridge
 *  - development: Three.js debug engine (never shipped to end users unless
 *    explicitly enabled with DEV_VIEWER=1)
 * Controls are sized in CSS pixels; keyboard: Space, ←/→, Home/End, R, +/−.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Controller, PackageClient, UnityEngine, type Engine, type FileUrls, type Speed, type ViewPreset, type ViewerState } from "@dentosim/viewer-core";
import { cx } from "@/components/ui";

export interface ViewerProps {
  /** returns fresh signed URLs for every package file */
  loadUrls: () => Promise<FileUrls>;
  mode?: "full" | "patient";
  embed?: boolean;
  engine: { kind: "unity"; buildUrl: string } | { kind: "three" } | { kind: "none" };
  gumColor?: string;
  className?: string;
}

const VIEWS: { v: ViewPreset; label: string }[] = [
  { v: "front", label: "Front" },
  { v: "right", label: "Right" },
  { v: "left", label: "Left" },
  { v: "upper-occlusal", label: "Upper" },
  { v: "lower-occlusal", label: "Lower" },
  { v: "both-occlusal", label: "Both occlusal" },
];

declare global {
  interface Window {
    createUnityInstance?: (canvas: HTMLCanvasElement, config: Record<string, unknown>, onProgress?: (p: number) => void) => Promise<import("@dentosim/viewer-core").UnityInstance>;
  }
}

async function createEngine(container: HTMLDivElement, spec: ViewerProps["engine"]): Promise<Engine> {
  if (spec.kind === "unity") {
    const base = spec.buildUrl.replace(/\/$/, "");
    await new Promise<void>((res, rej) => {
      if (window.createUnityInstance) return res();
      const s = document.createElement("script");
      s.src = `${base}/Build/DentoSim.loader.js`;
      s.onload = () => res();
      s.onerror = () => rej(new Error("Could not load the 3D viewer."));
      document.head.appendChild(s);
    });
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "width:100%;height:100%;display:block;touch-action:none";
    canvas.setAttribute("data-testid", "viewer-canvas");
    container.appendChild(canvas);
    const instance = await window.createUnityInstance!(canvas, {
      dataUrl: `${base}/Build/DentoSim.data`,
      frameworkUrl: `${base}/Build/DentoSim.framework.js`,
      codeUrl: `${base}/Build/DentoSim.wasm`,
      companyName: "DentoSim",
      productName: "DentoSim Viewer",
      productVersion: "1.0",
      matchWebGLToCanvasSize: true,
      devicePixelRatio: Math.min(window.devicePixelRatio, 2),
    });
    return new UnityEngine(instance);
  }
  const { ThreeEngine } = await import("./ThreeEngine");
  return new ThreeEngine(container);
}

export function Viewer({ loadUrls, mode = "full", embed = false, engine, gumColor, className }: ViewerProps) {
  const host = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const ctl = useRef<Controller | null>(null);
  const pkgRef = useRef<PackageClient | null>(null);
  const [state, setState] = useState<ViewerState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [disclaimer, setDisclaimer] = useState<string[]>([]);
  const [labels, setLabels] = useState<{ stage: string }>({ stage: "" });
  const [info, setInfo] = useState<string[]>([]);

  useEffect(() => {
    if (engine.kind === "none") return;
    let disposed = false;
    let controller: Controller | null = null;
    (async () => {
      try {
        const urls = await loadUrls();
        const pkg = new PackageClient(urls, { refreshUrls: loadUrls });
        const meta = await pkg.load();
        if (disposed) return;
        setDisclaimer(meta.disclaimer);
        const notes: string[] = [];
        if (meta.case.registration && !meta.case.registration.performed) notes.push("Bite from the planning export (no patient scans).");
        if (meta.case.normalization?.interArch === "reconstructed") notes.push("Bite relationship approximated.");
        if (Object.values(meta.case.segmentation?.jaws ?? {}).some((j) => j?.proceduralGums)) notes.push("Gums are illustrative.");
        setInfo(notes);
        const eng = await createEngine(host.current!, engine);
        if (disposed) { eng.dispose(); return; }
        pkgRef.current = pkg;
        controller = new Controller(eng, pkg, { gumColor: gumColor ?? "#d98a8f" });
        ctl.current = controller;
        controller.subscribe((s) => {
          setState(s);
          setLabels({ stage: pkg.stageLabel(s.stage) });
        });
        await controller.init();
      } catch (e) {
        if (!disposed) setError((e as Error).message);
      }
    })();
    return () => {
      disposed = true;
      controller?.dispose();
      ctl.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("input,textarea,select")) return;
      if (!wrap.current?.contains(document.activeElement) && document.activeElement !== document.body) return;
      ctl.current?.handleKey(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const c = ctl.current;
  const movement = useMemo(() => (state?.selected ? c?.movement() : null), [state?.selected, state?.stage, c]);

  const fullscreen = () => {
    const el = wrap.current!;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  };

  const screenshot = async () => {
    if (!c) return;
    const blob = await c.screenshot();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `simulation-stage-${state?.stage ?? 0}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  if (engine.kind === "none")
    return (
      <div className={cx("flex aspect-video items-center justify-center rounded-xl bg-stone-100 p-6 text-center text-sm text-stone-600", className)}>
        The 3D viewer build is not installed on this server (set UNITY_BUILD_URL).
      </div>
    );

  const btn = "h-9 min-w-9 rounded-lg px-2.5 text-sm font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-40 aria-pressed:bg-brand aria-pressed:text-white";
  const last = (state?.stageCount ?? 1) - 1;

  return (
    <div ref={wrap} tabIndex={-1} className={cx("flex flex-col overflow-hidden rounded-xl bg-white ring-1 ring-stone-200 outline-none", embed && "h-dvh rounded-none ring-0", className)} data-testid="viewer">
      <div className="relative min-h-[320px] flex-1 bg-gradient-to-b from-stone-50 to-stone-200">
        <div ref={host} className="absolute inset-0" />
        {!state && !error && <div className="absolute inset-0 flex items-center justify-center text-sm text-stone-500">Loading simulation…</div>}
        {error && <div role="alert" className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-red-700">{error}</div>}
        {state && (
          <div className="pointer-events-none absolute left-3 top-3 rounded-lg bg-white/85 px-2.5 py-1 text-sm font-medium tabular shadow-sm" data-testid="stage-label">
            {state.compare === "side-by-side" ? "Initial  ·  Final" : `Stage ${state.stage} / ${last}`}
            {labels.stage && labels.stage !== String(state.stage) && state.compare === "single" ? <span className="ml-1 text-stone-500">({labels.stage})</span> : null}
          </div>
        )}
        {engine.kind === "three" && !embed && <div className="pointer-events-none absolute right-3 top-3 rounded bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-900">Development viewer</div>}
        {state?.selected && (
          <div className="absolute bottom-3 left-3 max-w-[260px] rounded-lg bg-white/95 p-3 text-xs shadow ring-1 ring-stone-200" data-testid="tooth-info">
            <div className="mb-1 flex items-center justify-between gap-3">
              <strong className="text-sm">Tooth {state.selected.fdi ?? state.selected.toothId}</strong>
              <button className="text-stone-500" aria-label="Close" onClick={() => c?.selectTooth(null)}>✕</button>
            </div>
            {movement ? (
              <dl className="grid grid-cols-2 gap-x-3 gap-y-0.5 tabular">
                <dt className="text-stone-500">Total movement</dt><dd>{movement.translationMagnitudeMm.toFixed(2)} mm</dd>
                <dt className="text-stone-500">Mesial / distal</dt><dd>{movement.mesialDistalMm.toFixed(2)} mm</dd>
                <dt className="text-stone-500">Buccal / lingual</dt><dd>{movement.buccalLingualMm.toFixed(2)} mm</dd>
                <dt className="text-stone-500">Extrusion / intrusion</dt><dd>{movement.extrusionIntrusionMm.toFixed(2)} mm</dd>
                <dt className="text-stone-500">Rotation</dt><dd>{movement.rotationDeg.toFixed(1)}°</dd>
                <dt className="text-stone-500">Tip / torque</dt><dd>{movement.tipDeg.toFixed(1)}° / {movement.torqueDeg.toFixed(1)}°</dd>
              </dl>
            ) : (
              <p className="text-stone-500">{state.stage === 0 ? "Initial position." : "No movement data for this tooth."}</p>
            )}
          </div>
        )}
      </div>

      {state && (
        <div className="space-y-2 border-t border-stone-200 p-2 sm:p-3">
          <div className="flex items-center gap-2">
            <button className={btn} onClick={() => c?.prev()} disabled={state.stage === 0} aria-label="Previous stage">◀</button>
            <button className={cx(btn, "bg-brand text-white hover:bg-brand hover:brightness-110")} onClick={() => c?.toggle()} aria-label={state.playing ? "Pause" : "Play"} data-testid="play">
              {state.playing ? "❚❚" : "▶"}
            </button>
            <button className={btn} onClick={() => c?.next()} disabled={state.stage >= last} aria-label="Next stage">▶︎▶︎</button>
            <input type="range" min={0} max={last} value={state.stage} onChange={(e) => c?.seek(+e.target.value)} className="h-9 flex-1 accent-[var(--color-brand)]" aria-label="Stage" data-testid="stage-slider" />
            {mode === "full" && (
              <select className="h-9 rounded-lg bg-stone-100 px-2 text-sm" value={state.speed} onChange={(e) => c?.setSpeed(+e.target.value as Speed)} aria-label="Speed">
                {[1, 2, 4, 8].map((s) => <option key={s} value={s}>{s}×</option>)}
              </select>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <button className={btn} onClick={() => { void c?.setCompare("single"); c?.first(); }} data-testid="initial">Initial</button>
            <button className={btn} onClick={() => { void c?.setCompare("single"); c?.final(); }} data-testid="final">Final</button>
            <button className={btn} aria-pressed={state.compare === "side-by-side"} onClick={() => void c?.setCompare(state.compare === "side-by-side" ? "single" : "side-by-side")}>Side by side</button>
            {mode === "full" && <button className={btn} aria-pressed={state.compare === "overlay"} onClick={() => void c?.setCompare(state.compare === "overlay" ? "single" : "overlay")}>Overlay</button>}
            <span className="mx-1 h-5 w-px bg-stone-200" />
            {mode === "full" ? (
              VIEWS.map((v) => <button key={v.v} className={btn} aria-pressed={state.view === v.v} onClick={() => c?.setView(v.v)}>{v.label}</button>)
            ) : (
              <button className={btn} aria-pressed={state.view === "front" && state.jawOpeningMm === 0} onClick={() => { c?.setView("front"); c?.closeMouth(); }}>Bite view</button>
            )}
            <span className="mx-1 h-5 w-px bg-stone-200" />
            <button className={btn} onClick={() => (state.jawOpeningMm > 0 ? c?.closeMouth() : c?.openMouth())} data-testid="open-mouth">{state.jawOpeningMm > 0 ? "Close mouth" : "Open mouth"}</button>
            {mode === "full" && (
              <>
                <button className={btn} onClick={() => c?.cycleMouth()}>Cycle</button>
                <input type="range" min={0} max={20} step={0.5} value={state.jawOpeningMm} onChange={(e) => c?.setJawOpening(+e.target.value)} className="w-20 accent-[var(--color-brand)]" aria-label="Jaw opening (mm)" />
                <span className="mx-1 h-5 w-px bg-stone-200" />
                <label className="flex items-center gap-1 text-sm text-stone-700"><input type="checkbox" checked={state.showUpper} onChange={(e) => c?.setJaws(e.target.checked, state.showLower)} />Upper</label>
                <label className="flex items-center gap-1 text-sm text-stone-700"><input type="checkbox" checked={state.showLower} onChange={(e) => c?.setJaws(state.showUpper, e.target.checked)} />Lower</label>
                <label className="flex items-center gap-1 text-sm text-stone-700"><input type="checkbox" checked={state.showAttachments} onChange={(e) => c?.setAttachments(e.target.checked)} />Attachments</label>
                {state.hasScans && <label className="flex items-center gap-1 text-sm text-stone-700"><input type="checkbox" checked={state.showScans} onChange={(e) => void c?.setShowScans(e.target.checked)} />Original scans</label>}
                <label className="flex items-center gap-1 text-sm text-stone-700" title="Gum colour"><input type="color" value={state.gumColor} onChange={(e) => c?.setGumColor(e.target.value)} className="h-6 w-7 cursor-pointer rounded border-0 bg-transparent p-0" aria-label="Gum colour" /></label>
              </>
            )}
            <span className="flex-1" />
            <button className={btn} onClick={screenshot} aria-label="Save screenshot">PNG</button>
            <button className={btn} onClick={fullscreen} aria-label="Fullscreen">⛶</button>
          </div>
        </div>
      )}
      <p className="border-t border-stone-100 bg-stone-50 px-3 py-2 text-[11px] leading-snug text-stone-500" data-testid="disclaimer">
        {[...info, ...(disclaimer.length ? disclaimer : ["Stages are shown exactly as exported; no movement is interpolated. Gums may be illustrative. Jaw opening is simulated, not recorded patient motion."])].join(" ")}
      </p>
    </div>
  );
}
