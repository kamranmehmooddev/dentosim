// Scene graph of the production viewer: two slots (main + comparison), each with
// an upper arch and a lower arch under a hinge pivot; scans overlay; compare modes;
// two-arch occlusal layout; lab materials; tooth picking; screenshots.
using System.Collections.Generic;
using UnityEngine;

namespace DentoSim
{
    public class ViewerScene : MonoBehaviour
    {
        class Slot
        {
            public Transform root, upper, lowerPivot, lower;
        }

        readonly Slot[] slots = new Slot[2];
        Transform scanUpper, scanLower;
        Material tooth, gums, attachment, baseMat, arch, ghost, scanMat, highlight;
        string compare = "single";
        string view = "front";
        string highlightId = "";
        bool showAttachments = true;
        Vector3 hingePoint;
        float hingeAngleDeg;
        bool hasHinge;
        float extent = 0f;
        public CameraRig rig;

        static Material Mat(Color c, float alpha = 1f, float spec = 0.25f)
        {
            var m = new Material(Shader.Find("DentoSim/Lab"));
            c.a = alpha;
            m.SetColor("_Color", c);
            m.SetFloat("_Spec", spec);
            if (alpha < 1f) { m.SetFloat("_ZWrite", 0f); m.renderQueue = 3000; }
            return m;
        }

        static Color Hex(string hex, Color fallback) => ColorUtility.TryParseHtmlString(hex, out var c) ? c : fallback;

        void Awake()
        {
            tooth = Mat(new Color(0.945f, 0.918f, 0.847f), 1f, 0.35f);
            gums = Mat(new Color(0.85f, 0.54f, 0.56f), 1f, 0.15f);
            attachment = Mat(new Color(0.62f, 0.70f, 0.78f), 1f, 0.5f);
            baseMat = Mat(new Color(0.9f, 0.9f, 0.89f), 1f, 0.05f);
            arch = Mat(new Color(0.925f, 0.784f, 0.749f), 1f, 0.2f);
            ghost = Mat(new Color(0.36f, 0.55f, 0.94f), 0.32f, 0.1f);
            scanMat = Mat(new Color(0.5f, 0.65f, 0.85f), 0.35f, 0.1f);
            highlight = Mat(new Color(0.945f, 0.918f, 0.847f), 1f, 0.35f);
            highlight.SetColor("_Highlight", new Color(0.11f, 0.56f, 0.84f, 0.35f));
            for (int i = 0; i < 2; i++)
            {
                var s = new Slot();
                s.root = new GameObject($"slot{i}").transform;
                s.root.SetParent(transform, false);
                s.upper = new GameObject("upper").transform;
                s.upper.SetParent(s.root, false);
                s.lowerPivot = new GameObject("lowerPivot").transform;
                s.lowerPivot.SetParent(s.root, false);
                s.lower = new GameObject("lower").transform;
                s.lower.SetParent(s.lowerPivot, false);
                slots[i] = s;
            }
            slots[1].root.gameObject.SetActive(false);
        }

        Material MaterialFor(string kind) => kind switch
        {
            "tooth" => tooth,
            "gums" => gums,
            "attachment" => attachment,
            "base" => baseMat,
            _ => arch,
        };

        static void Clear(Transform t)
        {
            for (int i = t.childCount - 1; i >= 0; i--) Destroy(t.GetChild(i).gameObject);
        }

        GameObject Instantiate(PartMesh p, string jaw, Material forced = null)
        {
            var go = new GameObject(p.id);
            go.AddComponent<MeshFilter>().sharedMesh = p.mesh;
            go.AddComponent<MeshRenderer>().sharedMaterial = forced ? forced : MaterialFor(p.kind);
            var tag = go.AddComponent<PartTag>();
            tag.jaw = jaw;
            tag.id = p.id;
            tag.kind = p.kind;
            tag.fdi = p.fdi;
            return go;
        }

        public void SetStage(StageMsg msg)
        {
            var s = slots[Mathf.Clamp(msg.slot, 0, 1)];
            var parent = msg.jaw == "upper" ? s.upper : s.lower;
            // keep scan overlays (children of the arch groups) across stage changes
            for (int i = parent.childCount - 1; i >= 0; i--)
            {
                var child = parent.GetChild(i);
                if (child != scanLower && child != scanUpper) Destroy(child.gameObject);
            }
            if (string.IsNullOrEmpty(msg.key) || msg.parts == null) return;
            var holder = new GameObject(msg.key).transform;
            holder.SetParent(parent, false);
            foreach (var p in MeshLibrary.Get(msg.key, msg.parts))
                Instantiate(p, msg.jaw, msg.slot == 1 && compare == "overlay" ? ghost : null).transform.SetParent(holder, false);
            if (msg.slot == 0 && extent <= 0f) FitToContent();
            ApplyAppearance();
            Layout();
        }

        public void SetScan(ScanMsg msg)
        {
            ref Transform slotRef = ref (msg.jaw == "upper" ? ref scanUpper : ref scanLower);
            if (slotRef) { Destroy(slotRef.gameObject); slotRef = null; }
            if (string.IsNullOrEmpty(msg.key) || msg.parts == null) return;
            var holder = new GameObject($"scan-{msg.jaw}").transform;
            holder.SetParent(msg.jaw == "upper" ? slots[0].upper : slots[0].lower, false);
            foreach (var p in MeshLibrary.Get(msg.key, msg.parts))
            {
                var go = Instantiate(p, msg.jaw, scanMat);
                go.GetComponent<PartTag>().kind = "scan";
                go.transform.SetParent(holder, false);
            }
            slotRef = holder;
        }

        void FitToContent()
        {
            var b = new Bounds();
            bool any = false;
            foreach (var r in slots[0].root.GetComponentsInChildren<MeshRenderer>())
            {
                if (!any) { b = r.bounds; any = true; } else b.Encapsulate(r.bounds);
            }
            if (any) extent = Mathf.Max(b.size.x, b.size.y, b.size.z) * 1.15f;
        }

        public void SetCompare(string mode)
        {
            compare = mode;
            slots[1].root.gameObject.SetActive(mode != "single");
            foreach (var r in slots[1].root.GetComponentsInChildren<MeshRenderer>(true))
            {
                var tag = r.GetComponent<PartTag>();
                r.sharedMaterial = mode == "overlay" ? ghost : MaterialFor(tag.kind);
            }
            Layout();
        }

        public void SetView(string v)
        {
            view = v;
            Layout();
        }

        public void SetJaw(JawMsg m)
        {
            hasHinge = m.point != null && m.point.Length == 3;
            if (hasHinge) hingePoint = new Vector3(-m.point[0], m.point[1], m.point[2]);
            hingeAngleDeg = m.angleRad * Mathf.Rad2Deg;
            Layout();
        }

        /// compare modes, two-arch occlusal layout and the jaw hinge
        void Layout()
        {
            bool both = view == "both-occlusal";
            float e = extent > 0 ? extent : 70f;
            foreach (var s in slots)
            {
                s.upper.localRotation = both ? Quaternion.Euler(-90f, 0, 0) : Quaternion.identity;
                s.upper.localPosition = both ? new Vector3(0, e * 0.3f, 0) : Vector3.zero;
                if (hasHinge && !both)
                {
                    s.lowerPivot.localPosition = hingePoint;
                    // opening: incisors move down/back — rotation about the patient's left-right axis
                    s.lowerPivot.localRotation = Quaternion.AngleAxis(hingeAngleDeg, Vector3.right);
                    s.lower.localPosition = -hingePoint;
                    s.lower.localRotation = Quaternion.identity;
                }
                else
                {
                    s.lowerPivot.localPosition = Vector3.zero;
                    s.lowerPivot.localRotation = Quaternion.identity;
                    s.lower.localRotation = both ? Quaternion.Euler(90f, 0, 0) : Quaternion.identity;
                    s.lower.localPosition = both ? new Vector3(0, -e * 0.3f, 0) : Vector3.zero;
                }
            }
            float gap = e * 0.95f;
            // initial (slot 1) on the screen's left, final (slot 0) on the right; camera looks along −Z so screen-left is +X
            slots[0].root.localPosition = compare == "side-by-side" ? new Vector3(-gap / 2, 0, 0) : Vector3.zero;
            slots[1].root.localPosition = compare == "side-by-side" ? new Vector3(gap / 2, 0, 0) : Vector3.zero;
            if (rig) rig.Fit(e * (compare == "side-by-side" ? 1.9f : 1f) * (both ? 1.35f : 1f), 1f);
        }

        public void SetAppearance(AppearanceMsg a)
        {
            gums.SetColor("_Color", Hex(a.gumColor, gums.GetColor("_Color")));
            showAttachments = a.showAttachments;
            highlightId = a.highlightToothId ?? "";
            ApplyAppearance();
        }

        void ApplyAppearance()
        {
            foreach (var r in slots[0].root.GetComponentsInChildren<MeshRenderer>(true))
            {
                var tag = r.GetComponent<PartTag>();
                if (tag == null || tag.kind == "scan") continue;
                r.enabled = tag.kind != "attachment" || showAttachments;
                r.sharedMaterial = tag.kind == "tooth" && tag.id == highlightId && highlightId != "" ? highlight : MaterialFor(tag.kind);
            }
            foreach (var r in slots[1].root.GetComponentsInChildren<MeshRenderer>(true))
            {
                var tag = r.GetComponent<PartTag>();
                if (tag != null) r.enabled = tag.kind != "attachment" || showAttachments;
            }
        }

        public void SetTheme(ThemeMsg t)
        {
            if (rig && !string.IsNullOrEmpty(t.background)) rig.cam.backgroundColor = Hex(t.background, rig.cam.backgroundColor);
            if (!string.IsNullOrEmpty(t.gumColor)) gums.SetColor("_Color", Hex(t.gumColor, gums.GetColor("_Color")));
        }

        /// Ray-triangle picking against visible teeth of the main slot (no physics colliders needed).
        public PartTag Pick(Vector2 screen)
        {
            var ray = rig.cam.ScreenPointToRay(screen);
            PartTag best = null;
            float bestT = float.MaxValue;
            foreach (var r in slots[0].root.GetComponentsInChildren<MeshRenderer>())
            {
                var tag = r.GetComponent<PartTag>();
                if (tag == null || tag.kind != "tooth" || !r.enabled) continue;
                if (!r.bounds.IntersectRay(ray, out float boundT) || boundT > bestT) continue;
                var tr = r.transform;
                var local = new Ray(tr.InverseTransformPoint(ray.origin), tr.InverseTransformDirection(ray.direction));
                var mesh = r.GetComponent<MeshFilter>().sharedMesh;
                var v = mesh.vertices;
                var tris = mesh.triangles;
                for (int i = 0; i < tris.Length; i += 3)
                {
                    if (RayTriangle(local, v[tris[i]], v[tris[i + 1]], v[tris[i + 2]], out float t))
                    {
                        float world = (tr.TransformPoint(local.GetPoint(t)) - ray.origin).magnitude;
                        if (world < bestT) { bestT = world; best = tag; }
                    }
                }
            }
            return best;
        }

        static bool RayTriangle(Ray ray, Vector3 a, Vector3 b, Vector3 c, out float t)
        {
            t = 0;
            var e1 = b - a;
            var e2 = c - a;
            var p = Vector3.Cross(ray.direction, e2);
            float det = Vector3.Dot(e1, p);
            if (Mathf.Abs(det) < 1e-8f) return false;
            float inv = 1f / det;
            var s = ray.origin - a;
            float u = Vector3.Dot(s, p) * inv;
            if (u < 0 || u > 1) return false;
            var q = Vector3.Cross(s, e1);
            float w = Vector3.Dot(ray.direction, q) * inv;
            if (w < 0 || u + w > 1) return false;
            t = Vector3.Dot(e2, q) * inv;
            return t > 0;
        }

        public byte[] Screenshot(int width, int height)
        {
            var rt = new RenderTexture(width, height, 24) { antiAliasing = 4 };
            var prev = rig.cam.targetTexture;
            rig.cam.targetTexture = rt;
            rig.cam.Render();
            RenderTexture.active = rt;
            var tex = new Texture2D(width, height, TextureFormat.RGB24, false);
            tex.ReadPixels(new Rect(0, 0, width, height), 0, 0);
            tex.Apply();
            rig.cam.targetTexture = prev;
            RenderTexture.active = null;
            var png = tex.EncodeToPNG();
            Destroy(tex);
            rt.Release();
            Destroy(rt);
            return png;
        }
    }

    public class PartTag : MonoBehaviour
    {
        public string jaw;
        public string id;
        public string kind;
        public int fdi;
    }
}
