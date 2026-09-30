// JSON payloads sent by packages/viewer-core/src/unity-engine.ts (JsonUtility-compatible).
using System;

namespace DentoSim
{
    [Serializable] public class PartInfo { public int index; public string id; public string kind; public int fdi; public int vertexCount; public int indexCount; }
    [Serializable] public class StageMsg { public int slot; public string jaw; public string key; public PartInfo[] parts; }
    [Serializable] public class ScanMsg { public string jaw; public string key; public PartInfo[] parts; }
    [Serializable] public class ViewMsg { public string view; public bool animate; }
    [Serializable] public class JawMsg { public float angleRad; public float[] point; public float[] axis; }
    [Serializable] public class AppearanceMsg { public string gumColor; public bool showAttachments; public string highlightToothId; }
    [Serializable] public class ThemeMsg { public string background; public string gumColor; }
    [Serializable] public class ToothTapEvent { public string type = "toothTap"; public string jaw; public string toothId; public int fdi; }
}
