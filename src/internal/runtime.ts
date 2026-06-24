export type Runtime =
  | "node"
  | "bun"
  | "deno"
  | "workerd"
  | "edge"
  | "browser"
  | "unknown";

export function detectRuntime(): Runtime {
  // @ts-expect-error - Deno global not in Node types
  if (typeof Deno !== "undefined") return "deno";
  // @ts-expect-error - Bun global not in Node types
  if (typeof Bun !== "undefined") return "bun";
  if (typeof WorkerGlobalScope !== "undefined") {
    // Narrow to Cloudflare Workers: navigator.userAgent is "Cloudflare-Workers"
    if (
      typeof navigator !== "undefined" &&
      navigator.userAgent === "Cloudflare-Workers"
    ) {
      return "workerd";
    }
  }
  // @ts-expect-error - EdgeRuntime not in Node types
  if (typeof EdgeRuntime !== "undefined") return "edge";
  // @ts-expect-error - window not available in Node types
  if (typeof window !== "undefined") return "browser";
  if (typeof process !== "undefined" && process.versions.node) return "node";
  return "unknown";
}

export function runtimeVersion(runtime: Runtime): string {
  switch (runtime) {
    case "node":
      return process.versions.node;
    case "bun": {
      // @ts-expect-error - Bun global not in Node types
      const bun = Bun as { version: string };
      return bun.version;
    }
    case "deno": {
      // @ts-expect-error - Deno global not in Node types
      const deno = Deno as { version: { deno: string } };
      return deno.version.deno;
    }
    default:
      return "unknown";
  }
}
