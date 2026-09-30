// Builds Unity meshes from parts decoded in JavaScript (TSM2 + meshopt) without
// re-parsing: the jslib copies positions/normals/indices straight into C# arrays.
// DentoSim frame (right-handed, +X patient left) → Unity (left-handed): negate X
// and reverse triangle winding.
using System.Collections.Generic;
using System.Runtime.InteropServices;
using UnityEngine;
using UnityEngine.Rendering;

namespace DentoSim
{
    public class PartMesh
    {
        public string id;
        public string kind;
        public int fdi;
        public Mesh mesh;
    }

    public static class MeshLibrary
    {
#if UNITY_WEBGL && !UNITY_EDITOR
        [DllImport("__Internal")] static extern int DentoSim_CopyPart(string key, int index, float[] positions, float[] normals, int[] indices);
#else
        static int DentoSim_CopyPart(string key, int index, float[] positions, float[] normals, int[] indices) => 0;
#endif

        static readonly Dictionary<string, List<PartMesh>> cache = new Dictionary<string, List<PartMesh>>();
        static readonly LinkedList<string> order = new LinkedList<string>();
        const int MaxEntries = 70;

        public static List<PartMesh> Get(string key, PartInfo[] parts)
        {
            if (cache.TryGetValue(key, out var hit))
            {
                order.Remove(key);
                order.AddLast(key);
                return hit;
            }
            var list = new List<PartMesh>(parts.Length);
            foreach (var p in parts)
            {
                var pos = new float[p.vertexCount * 3];
                var nrm = new float[p.vertexCount * 3];
                var idx = new int[p.indexCount];
                if (DentoSim_CopyPart(key, p.index, pos, nrm, idx) == 0) continue;
                list.Add(new PartMesh { id = p.id, kind = p.kind, fdi = p.fdi, mesh = Build(pos, nrm, idx, p.id) });
            }
            cache[key] = list;
            order.AddLast(key);
            while (order.Count > MaxEntries)
            {
                var old = order.First.Value;
                order.RemoveFirst();
                foreach (var pm in cache[old]) Object.Destroy(pm.mesh);
                cache.Remove(old);
            }
            return list;
        }

        public static Mesh Build(float[] pos, float[] nrm, int[] idx, string name)
        {
            int n = pos.Length / 3;
            var v = new Vector3[n];
            var nn = new Vector3[n];
            for (int i = 0; i < n; i++)
            {
                v[i] = new Vector3(-pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
                nn[i] = new Vector3(-nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]);
            }
            // mirroring X flips handedness: swap two indices per triangle to keep front faces outward
            for (int t = 0; t + 2 < idx.Length; t += 3)
            {
                int tmp = idx[t + 1];
                idx[t + 1] = idx[t + 2];
                idx[t + 2] = tmp;
            }
            var m = new Mesh { name = name, indexFormat = n > 65535 ? IndexFormat.UInt32 : IndexFormat.UInt16 };
            m.vertices = v;
            m.normals = nn;
            m.SetIndices(idx, MeshTopology.Triangles, 0, true);
            m.RecalculateBounds();
            return m;
        }
    }
}
