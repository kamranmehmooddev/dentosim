import "server-only";
import { config } from "@dentosim/server";

/** Which 3D engine the browser should use. Unity in production; Three.js only as a development tool. */
export function viewerEngine(): { kind: "unity"; buildUrl: string } | { kind: "three" } | { kind: "none" } {
  const url = config().UNITY_BUILD_URL;
  if (url) return { kind: "unity", buildUrl: url };
  if (process.env.NODE_ENV !== "production" || process.env.DEV_VIEWER === "1") return { kind: "three" };
  return { kind: "none" };
}
