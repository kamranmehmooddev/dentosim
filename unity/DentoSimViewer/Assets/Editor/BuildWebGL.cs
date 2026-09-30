// Batch-mode build of the production viewer:
//   Unity -batchmode -quit -projectPath unity/DentoSimViewer \
//         -executeMethod DentoSim.EditorTools.BuildWebGL.Build -buildOutput ../../apps/web/public/unity/viewer
// Produces Build/DentoSim.{loader.js,data,framework.js,wasm} (no compression → any static host;
// enable Brotli/Gzip on the CDN instead). Set UNITY_BUILD_URL to the output URL.
using System;
using System.IO;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace DentoSim.EditorTools
{
    public static class BuildWebGL
    {
        const string ScenePath = "Assets/Scenes/Main.unity";

        [MenuItem("DentoSim/Build WebGL viewer")]
        public static void BuildFromMenu() => Build(Path.GetFullPath("Build/WebGL"));

        public static void Build() => Build(ArgValue("-buildOutput") ?? Path.GetFullPath("Build/WebGL"));

        static string ArgValue(string name)
        {
            var args = Environment.GetCommandLineArgs();
            var i = Array.IndexOf(args, name);
            return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
        }

        static void EnsureScene()
        {
            if (File.Exists(ScenePath)) return;
            Directory.CreateDirectory(Path.GetDirectoryName(ScenePath));
            var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
            EditorSceneManager.SaveScene(scene, ScenePath);
        }

        static void Build(string output)
        {
            EnsureScene();
            PlayerSettings.productName = "DentoSim Viewer";
            PlayerSettings.companyName = "DentoSim";
            PlayerSettings.WebGL.compressionFormat = WebGLCompressionFormat.Disabled;
            PlayerSettings.WebGL.linkerTarget = WebGLLinkerTarget.Wasm;
            PlayerSettings.WebGL.memorySize = 512;
            PlayerSettings.WebGL.template = "PROJECT:DentoSim";
            PlayerSettings.WebGL.dataCaching = true;
            PlayerSettings.WebGL.exceptionSupport = WebGLExceptionSupport.ExplicitlyThrownExceptionsOnly;
            PlayerSettings.colorSpace = ColorSpace.Linear;
            PlayerSettings.stripEngineCode = true;
            // always include the lab shader (it is loaded with Shader.Find)
            var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
            {
                scenes = new[] { ScenePath },
                locationPathName = output,
                target = BuildTarget.WebGL,
                options = BuildOptions.None,
            });
            // Unity names files after the output folder; normalise to DentoSim.*
            var buildDir = Path.Combine(output, "Build");
            var stem = new DirectoryInfo(output).Name;
            foreach (var ext in new[] { ".loader.js", ".data", ".framework.js", ".wasm" })
            {
                var from = Path.Combine(buildDir, stem + ext);
                var to = Path.Combine(buildDir, "DentoSim" + ext);
                if (File.Exists(from) && from != to) { if (File.Exists(to)) File.Delete(to); File.Move(from, to); }
            }
            Debug.Log($"DentoSim WebGL build: {report.summary.result}, {report.summary.totalSize / 1e6:F1} MB → {output}");
            if (report.summary.result != UnityEditor.Build.Reporting.BuildResult.Succeeded) EditorApplication.Exit(1);
        }
    }
}
