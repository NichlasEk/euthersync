export class EutherWormhole {
  constructor(config) {
    this.config = config;
    this.selected = null;
  }

  async connect() {
    const endpoints = [...(this.config?.endpoints || [])].sort((a, b) => a.priority - b.priority);
    const checks = await Promise.all(endpoints.map((endpoint) => this.check(endpoint)));
    const available = checks
      .filter((check) => check.ok)
      .sort((a, b) => {
        if (a.endpoint.priority !== b.endpoint.priority) return a.endpoint.priority - b.endpoint.priority;
        return a.latencyMs - b.latencyMs;
      });
    this.selected = available[0] || null;
    return this.status();
  }

  status() {
    if (!this.selected) return { label: "Offline", kind: "offline", baseUrl: "" };
    if (this.selected.endpoint.kind === "lan") {
      return { label: "Connected locally", kind: "local", baseUrl: this.selected.endpoint.url };
    }
    return {
      label: "Connected via public server",
      kind: "public",
      baseUrl: this.selected.endpoint.url
    };
  }

  url(path) {
    const baseUrl = this.selected?.endpoint.url || "";
    return `${baseUrl}${path}`;
  }

  async check(endpoint) {
    const start = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2500);
    try {
      const response = await fetch(`${endpoint.url}/health`, {
        cache: "no-store",
        signal: controller.signal
      });
      return {
        endpoint,
        ok: response.ok,
        latencyMs: performance.now() - start
      };
    } catch {
      return { endpoint, ok: false, latencyMs: Number.POSITIVE_INFINITY };
    } finally {
      clearTimeout(timeout);
    }
  }
}
