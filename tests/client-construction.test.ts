import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Noukai, AuthenticationError } from "../src/index.js";

describe("API key resolution", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => { process.env = { ...originalEnv }; });
  afterEach(() => { process.env = originalEnv; });

  it("explicit key wins over env var", () => {
    process.env.NOUKAI_API_KEY = "nk_env";
    const noukai = new Noukai({ apiKey: "nk_explicit" });
    // Access via internal field for test only — Phase 4 will expose a getter for tests
    expect((noukai as any)._transport.apiKey).toBe("nk_explicit");
  });

  it("env var fallback", () => {
    process.env.NOUKAI_API_KEY = "nk_env";
    delete process.env.NOUKAI_BASE_URL;
    const noukai = new Noukai();
    expect((noukai as any)._transport.apiKey).toBe("nk_env");
  });

  it("no key throws AuthenticationError", () => {
    delete process.env.NOUKAI_API_KEY;
    expect(() => new Noukai()).toThrow(AuthenticationError);
  });

  it("wrong prefix throws AuthenticationError", () => {
    expect(() => new Noukai({ apiKey: "sk_wrong" })).toThrow(AuthenticationError);
  });
});

describe("base URL", () => {
  const originalEnv = { ...process.env };
  beforeEach(() => { process.env = { ...originalEnv }; });
  afterEach(() => { process.env = originalEnv; });

  it("defaults to api.noukai.dev production URL", () => {
    delete process.env.NOUKAI_ENV;
    const noukai = new Noukai({ apiKey: "nk_x" });
    expect((noukai as any)._transport.baseUrl).toBe("https://api.noukai.dev/api/v1");
  });

  it("env: 'dev' option points at localhost:8080", () => {
    const noukai = new Noukai({ apiKey: "nk_x", env: "dev" });
    expect((noukai as any)._transport.baseUrl).toBe("http://localhost:8080/api/v1");
  });

  it("env: 'production' option uses production URL", () => {
    delete process.env.NOUKAI_ENV;
    const noukai = new Noukai({ apiKey: "nk_x", env: "production" });
    expect((noukai as any)._transport.baseUrl).toBe("https://api.noukai.dev/api/v1");
  });

  it("NOUKAI_ENV=dev env var points at localhost:8080", () => {
    process.env.NOUKAI_ENV = "dev";
    const noukai = new Noukai({ apiKey: "nk_x" });
    expect((noukai as any)._transport.baseUrl).toBe("http://localhost:8080/api/v1");
  });

  it("NOUKAI_ENV=development is treated the same as 'dev'", () => {
    process.env.NOUKAI_ENV = "development";
    const noukai = new Noukai({ apiKey: "nk_x" });
    expect((noukai as any)._transport.baseUrl).toBe("http://localhost:8080/api/v1");
  });

  it("env: 'dev' option wins over NOUKAI_ENV=production env var", () => {
    process.env.NOUKAI_ENV = "production";
    const noukai = new Noukai({ apiKey: "nk_x", env: "dev" });
    expect((noukai as any)._transport.baseUrl).toBe("http://localhost:8080/api/v1");
  });

  it("NOUKAI_BASE_URL env var is ignored — no escape hatch via env", () => {
    process.env.NOUKAI_BASE_URL = "https://attacker.example.com/api/v1";
    delete process.env.NOUKAI_ENV;
    const noukai = new Noukai({ apiKey: "nk_x" });
    expect((noukai as any)._transport.baseUrl).toBe("https://api.noukai.dev/api/v1");
  });
});

describe("context manager equivalent (using)", () => {
  it("supports Symbol.asyncDispose", async () => {
    const noukai = new Noukai({ apiKey: "nk_x" });
    expect(typeof noukai[Symbol.asyncDispose]).toBe("function");
    await noukai[Symbol.asyncDispose]();
  });

  it("close() is idempotent", async () => {
    const noukai = new Noukai({ apiKey: "nk_x" });
    await noukai.close();
    await expect(noukai.close()).resolves.not.toThrow();
  });
});

describe("Flow construction", () => {
  it("string form parses three parts", () => {
    const flow = new Noukai({ apiKey: "nk_x" }).flow("acme/spelling/grade-3");
    expect(flow.org).toBe("acme");
    expect(flow.project).toBe("spelling");
    expect(flow.slug).toBe("grade-3");
  });

  it("kwargs form", () => {
    const flow = new Noukai({ apiKey: "nk_x" }).flow({
      org: "acme", project: "spelling", slug: "grade-3",
    });
    expect(flow.org).toBe("acme");
  });

  it("string form with wrong part count throws", () => {
    const n = new Noukai({ apiKey: "nk_x" });
    // Two segments is ambiguous (not a single slug, not fully qualified).
    expect(() => n.flow("acme/spelling")).toThrow(/single slug name|org\/project\/slug/);
    // Four segments is too many.
    expect(() => n.flow("acme/spelling/grade/extra")).toThrow(/single slug name|org\/project\/slug/);
  });

  it("single-segment slug without defaults throws helpful error", () => {
    const n = new Noukai({ apiKey: "nk_x" });
    expect(() => n.flow("grade-3")).toThrow(/constructed with org and project/);
  });

  it("kwargs missing fields throws", () => {
    const n = new Noukai({ apiKey: "nk_x" });
    expect(() => n.flow({ org: "a", project: "b", slug: "" })).toThrow();
  });
});

describe("client-level org/project defaults", () => {
  it("single-segment slug uses defaults", () => {
    const noukai = new Noukai({
      apiKey: "nk_x",
      org: "abc",
      project: "nouko",
    });
    const flow = noukai.flow("language-analysis");
    expect(flow.org).toBe("abc");
    expect(flow.project).toBe("nouko");
    expect(flow.slug).toBe("language-analysis");
  });

  it("three-segment slug overrides defaults", () => {
    const noukai = new Noukai({
      apiKey: "nk_x",
      org: "abc",
      project: "nouko",
    });
    const flow = noukai.flow("other-org/other-project/other-slug");
    expect(flow.org).toBe("other-org");
    expect(flow.project).toBe("other-project");
    expect(flow.slug).toBe("other-slug");
  });

  it("kwargs form overrides defaults", () => {
    const noukai = new Noukai({
      apiKey: "nk_x",
      org: "abc",
      project: "nouko",
    });
    const flow = noukai.flow({
      org: "other", project: "other-proj", slug: "other-slug",
    });
    expect(flow.org).toBe("other");
  });

  it("org without project throws", () => {
    expect(
      () => new Noukai({ apiKey: "nk_x", org: "abc" }),
    ).toThrow(/together/);
  });

  it("project without org throws", () => {
    expect(
      () => new Noukai({ apiKey: "nk_x", project: "nouko" }),
    ).toThrow(/together/);
  });

  it("exposes defaultOrg and defaultProject getters", () => {
    const noukai = new Noukai({ apiKey: "nk_x", org: "abc", project: "nouko" });
    expect(noukai.defaultOrg).toBe("abc");
    expect(noukai.defaultProject).toBe("nouko");
  });

  it("defaults are undefined when not provided", () => {
    const noukai = new Noukai({ apiKey: "nk_x" });
    expect(noukai.defaultOrg).toBeUndefined();
    expect(noukai.defaultProject).toBeUndefined();
  });
});
