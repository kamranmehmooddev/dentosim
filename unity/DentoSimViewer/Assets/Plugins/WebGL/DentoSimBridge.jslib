// Unity → JavaScript side of the DentoSim bridge.
// The page (packages/viewer-core/src/unity-engine.ts) installs window.DentoSimBridge
// with decoded TSM2 parts keyed by "<jaw>:<stage>" (or "scan:<jaw>").
mergeInto(LibraryManager.library, {
  // Copy one decoded part straight into C#-allocated arrays (positions/normals: float[3n], indices: int[3t]).
  DentoSim_CopyPart: function (keyPtr, index, posPtr, normPtr, idxPtr) {
    var key = UTF8ToString(keyPtr);
    var b = window.DentoSimBridge;
    var parts = b && b.parts.get(key);
    if (!parts || !parts[index]) return 0;
    var p = parts[index];
    HEAPF32.set(p.positions, posPtr >> 2);
    HEAPF32.set(p.normals, normPtr >> 2);
    HEAP32.set(new Int32Array(p.triangles.buffer, p.triangles.byteOffset, p.triangles.length), idxPtr >> 2);
    return 1;
  },

  DentoSim_Emit: function (jsonPtr) {
    var b = window.DentoSimBridge;
    if (b) b.emit(UTF8ToString(jsonPtr));
  },

  DentoSim_Screenshot: function (ptr, len) {
    var b = window.DentoSimBridge;
    if (b) b.screenshot(HEAPU8.slice(ptr, ptr + len));
  },

  DentoSim_DevicePixelRatio: function () {
    return window.devicePixelRatio || 1;
  }
});
