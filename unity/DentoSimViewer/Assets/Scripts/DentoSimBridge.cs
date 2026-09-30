// Entry point: receives SendMessage("DentoSimBridge", method, json) from the web page
// (packages/viewer-core/src/unity-engine.ts) and reports taps/screenshots back via the jslib.
// The scene is built at runtime, so the Unity project needs no hand-authored scene content.
using System.Runtime.InteropServices;
using UnityEngine;

namespace DentoSim
{
    public class DentoSimBridge : MonoBehaviour
    {
#if UNITY_WEBGL && !UNITY_EDITOR
        [DllImport("__Internal")] static extern void DentoSim_Emit(string json);
        [DllImport("__Internal")] static extern void DentoSim_Screenshot(byte[] data, int length);
#else
        static void DentoSim_Emit(string json) => Debug.Log($"[DentoSim] {json}");
        static void DentoSim_Screenshot(byte[] data, int length) => Debug.Log($"[DentoSim] screenshot {length} bytes");
#endif

        ViewerScene scene;
        CameraRig rig;

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Bootstrap()
        {
            if (FindObjectOfType<DentoSimBridge>() != null) return;
            Application.targetFrameRate = 60;
            QualitySettings.antiAliasing = 4;
            var go = new GameObject("DentoSimBridge");
            go.AddComponent<DentoSimBridge>();
        }

        void Awake()
        {
            var camGo = new GameObject("Camera");
            rig = camGo.AddComponent<CameraRig>();
            var sceneGo = new GameObject("Scene");
            scene = sceneGo.AddComponent<ViewerScene>();
            scene.rig = rig;
            rig.onTap = OnTap;
#if UNITY_WEBGL && !UNITY_EDITOR
            // the page owns keyboard input (Space, arrows…) — do not swallow it
            WebGLInput.captureAllKeyboardInput = false;
#endif
        }

        void OnTap(Vector2 screen)
        {
            var hit = scene.Pick(screen);
            var e = new ToothTapEvent { jaw = hit ? hit.jaw : null, toothId = hit ? hit.id : null, fdi = hit ? hit.fdi : 0 };
            DentoSim_Emit(JsonUtility.ToJson(e));
        }

        // ───── messages from JavaScript ─────
        public void SetStage(string json) => scene.SetStage(JsonUtility.FromJson<StageMsg>(json));
        public void SetScan(string json) => scene.SetScan(JsonUtility.FromJson<ScanMsg>(json));
        public void SetCompare(string mode) => scene.SetCompare(mode);
        public void SetAppearance(string json) => scene.SetAppearance(JsonUtility.FromJson<AppearanceMsg>(json));
        public void SetJawOpening(string json) => scene.SetJaw(JsonUtility.FromJson<JawMsg>(json));
        public void SetTheme(string json) => scene.SetTheme(JsonUtility.FromJson<ThemeMsg>(json));

        public void SetView(string json)
        {
            var m = JsonUtility.FromJson<ViewMsg>(json);
            rig.SetPreset(m.view, m.animate);
            scene.SetView(m.view);
        }

        public void TakeScreenshot(string _)
        {
            var png = scene.Screenshot(Mathf.Max(800, Screen.width), Mathf.Max(600, Screen.height));
            DentoSim_Screenshot(png, png.Length);
        }
    }
}
