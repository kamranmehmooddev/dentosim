// Orthographic camera with lab-viewer presets and touch/mouse navigation:
// one finger / left mouse = orbit, two fingers = pan + pinch zoom,
// right/middle mouse = pan, wheel = zoom. Taps are forwarded to the scene.
using UnityEngine;

namespace DentoSim
{
    public class CameraRig : MonoBehaviour
    {
        public Camera cam;
        public System.Action<Vector2> onTap;
        public float baseSize = 40f; // orthographic half-height (mm)

        Vector3 target = Vector3.zero;
        float distance = 250f;
        float zoom = 1f;
        Quaternion rotation = Quaternion.identity;
        Quaternion animFrom, animTo;
        float animT = 1f;
        Vector2 downPos;
        float downTime;
        bool dragging;
        float lastPinch;
        Vector2 lastPan;

        void Awake()
        {
            cam = gameObject.AddComponent<Camera>();
            cam.orthographic = true;
            cam.nearClipPlane = 0.1f;
            cam.farClipPlane = 1000f;
            cam.clearFlags = CameraClearFlags.SolidColor;
            cam.backgroundColor = new Color(0.96f, 0.96f, 0.95f, 1f);
            cam.allowMSAA = true;
            SetPreset("front", false);
        }

        /// DentoSim views (Unity frame: X mirrored, face toward +Z).
        public void SetPreset(string view, bool animate)
        {
            Quaternion q;
            switch (view)
            {
                case "right": q = Quaternion.LookRotation(Vector3.left, Vector3.up); break;          // camera on patient's right looking at the face side
                case "left": q = Quaternion.LookRotation(Vector3.right, Vector3.up); break;
                case "upper-occlusal": q = Quaternion.LookRotation(Vector3.up, Vector3.forward); break; // from below, anterior at top
                case "lower-occlusal": q = Quaternion.LookRotation(Vector3.down, Vector3.forward); break; // from above
                default: q = Quaternion.LookRotation(Vector3.back, Vector3.up); break;                 // front: camera on +Z looking back
            }
            target = Vector3.zero;
            zoom = 1f;
            if (animate) { animFrom = rotation; animTo = q; animT = 0f; }
            else { rotation = q; animT = 1f; }
            Apply();
        }

        void Apply()
        {
            transform.rotation = rotation;
            transform.position = target - rotation * Vector3.forward * distance;
            cam.orthographicSize = baseSize / zoom;
        }

        void Update()
        {
            if (animT < 1f)
            {
                animT = Mathf.Min(1f, animT + Time.deltaTime / 0.35f);
                float e = 1f - Mathf.Pow(1f - animT, 3f);
                rotation = Quaternion.Slerp(animFrom, animTo, e);
                Apply();
            }
            if (Input.touchCount > 0) HandleTouch();
            else HandleMouse();
        }

        void Orbit(Vector2 delta)
        {
            float k = 0.25f;
            rotation = Quaternion.AngleAxis(delta.x * k, Vector3.up) * rotation;
            rotation = rotation * Quaternion.AngleAxis(-delta.y * k, Vector3.right);
            animT = 1f;
            Apply();
        }

        void Pan(Vector2 delta)
        {
            float mmPerPixel = 2f * cam.orthographicSize / Mathf.Max(1, Screen.height);
            target -= (transform.right * delta.x + transform.up * delta.y) * mmPerPixel;
            Apply();
        }

        void Zoom(float factor)
        {
            zoom = Mathf.Clamp(zoom * factor, 0.4f, 8f);
            Apply();
        }

        void HandleMouse()
        {
            if (Input.GetMouseButtonDown(0)) { downPos = Input.mousePosition; downTime = Time.time; dragging = false; }
            if (Input.GetMouseButton(0))
            {
                Vector2 d = new Vector2(Input.GetAxis("Mouse X"), Input.GetAxis("Mouse Y")) * 10f;
                if (((Vector2)Input.mousePosition - downPos).magnitude > 6f) dragging = true;
                if (dragging) Orbit(d);
            }
            if (Input.GetMouseButtonUp(0) && !dragging && Time.time - downTime < 0.5f) onTap?.Invoke(Input.mousePosition);
            if (Input.GetMouseButton(1) || Input.GetMouseButton(2)) Pan(new Vector2(Input.GetAxis("Mouse X"), Input.GetAxis("Mouse Y")) * 10f);
            float wheel = Input.mouseScrollDelta.y;
            if (Mathf.Abs(wheel) > 0.01f) Zoom(wheel > 0 ? 1.1f : 1f / 1.1f);
        }

        void HandleTouch()
        {
            if (Input.touchCount == 1)
            {
                var t = Input.GetTouch(0);
                if (t.phase == TouchPhase.Began) { downPos = t.position; downTime = Time.time; dragging = false; }
                if (t.phase == TouchPhase.Moved)
                {
                    if ((t.position - downPos).magnitude > 8f) dragging = true;
                    if (dragging) Orbit(t.deltaPosition);
                }
                if (t.phase == TouchPhase.Ended && !dragging && Time.time - downTime < 0.5f) onTap?.Invoke(t.position);
            }
            else if (Input.touchCount >= 2)
            {
                var a = Input.GetTouch(0);
                var b = Input.GetTouch(1);
                float dist = Vector2.Distance(a.position, b.position);
                Vector2 mid = (a.position + b.position) * 0.5f;
                if (a.phase == TouchPhase.Began || b.phase == TouchPhase.Began) { lastPinch = dist; lastPan = mid; dragging = true; return; }
                if (lastPinch > 0) Zoom(dist / lastPinch);
                Pan(mid - lastPan);
                lastPinch = dist;
                lastPan = mid;
            }
        }

        /// Fit the orthographic size to content extent (identical scale across stages).
        public void Fit(float extentMm, float widthFactor)
        {
            float aspect = (float)Screen.width / Mathf.Max(1, Screen.height);
            float half = extentMm * 0.5f;
            baseSize = aspect >= widthFactor ? half : half * widthFactor / aspect;
            Apply();
        }
    }
}
