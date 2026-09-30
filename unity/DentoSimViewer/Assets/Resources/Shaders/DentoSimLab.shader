// Lab-style material: Lambert + soft Blinn highlight from a headlight that
// travels with the camera (independent of scene lights), double-sided,
// optional transparency (overlay ghost / scans) and highlight tint.
Shader "DentoSim/Lab"
{
    Properties
    {
        _Color ("Color", Color) = (0.95, 0.92, 0.85, 1)
        _Highlight ("Highlight", Color) = (0, 0, 0, 0)
        _Gloss ("Gloss", Range(1, 128)) = 24
        _Spec ("Specular", Range(0, 1)) = 0.25
        [HideInInspector] _ZWrite ("ZWrite", Float) = 1
    }
    SubShader
    {
        Tags { "Queue" = "Geometry" "RenderType" = "Opaque" }
        Pass
        {
            Cull Off
            ZWrite [_ZWrite]
            Blend SrcAlpha OneMinusSrcAlpha
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "UnityCG.cginc"

            fixed4 _Color;
            fixed4 _Highlight;
            float _Gloss;
            float _Spec;
            float _ZWrite;

            struct appdata { float4 vertex : POSITION; float3 normal : NORMAL; };
            struct v2f { float4 pos : SV_POSITION; float3 nView : TEXCOORD0; float3 pView : TEXCOORD1; };

            v2f vert (appdata v)
            {
                v2f o;
                o.pos = UnityObjectToClipPos(v.vertex);
                o.nView = normalize(mul((float3x3)UNITY_MATRIX_IT_MV, v.normal));
                o.pView = UnityObjectToViewPos(v.vertex);
                return o;
            }

            fixed4 frag (v2f i, fixed facing : VFACE) : SV_Target
            {
                float3 n = normalize(i.nView) * (facing > 0 ? 1 : -1);
                // headlight slightly above-right of the viewer, in view space
                float3 l = normalize(float3(0.2, 0.3, 1.0));
                float3 v = float3(0, 0, 1);
                float diff = saturate(dot(n, l));
                float spec = pow(saturate(dot(n, normalize(l + v))), _Gloss) * _Spec;
                float3 c = _Color.rgb * (0.30 + 0.70 * diff) + spec;
                c = lerp(c, _Highlight.rgb, _Highlight.a);
                return fixed4(c, _Color.a);
            }
            ENDCG
        }
    }
}
