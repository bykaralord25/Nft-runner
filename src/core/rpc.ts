import type { ChainConfig } from "./chains.js";
import { redactRpcUrl, redactText } from "./secrets.js";

export type RpcStatus = "Connected" | "Wrong network" | "Unavailable";

export type RpcEndpoint = {
  url: string;
  label: string;
  redactedUrl: string;
  status: RpcStatus;
  latencyMs?: number;
  chainId?: number;
  readCapable: boolean;
  broadcastCapable: boolean;
  error?: string;
};

export class JsonRpcClient {
  constructor(public readonly url: string, private readonly timeoutMs = 8000) {
    assertSafeRpcUrl(url);
  }

  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = (await response.json()) as { result?: T; error?: { message?: string } };
      if (body.error) throw new Error(body.error.message || "RPC error");
      if (!Object.prototype.hasOwnProperty.call(body, "result")) throw new Error("Malformed RPC response.");
      return body.result as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function assertSafeRpcUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error("RPC URL is invalid.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("RPC URL must use http or https.");
  }
  if (url.username || url.password) {
    throw new Error("RPC URL credentials are not supported. Use a provider URL with a token instead.");
  }
  return url;
}

export async function classifyRpcUrl(url: string, chain: ChainConfig): Promise<RpcEndpoint> {
  const started = performance.now();
  const redactedUrl = redactRpcUrl(url);
  const base = { url, label: labelRpc(url), redactedUrl, readCapable: false, broadcastCapable: false };
  try {
    assertSafeRpcUrl(url);
    const client = new JsonRpcClient(url);
    const chainIdHex = await client.call<string>("eth_chainId");
    const latencyMs = Math.round(performance.now() - started);
    if (typeof chainIdHex !== "string" || !/^0x[0-9a-f]+$/i.test(chainIdHex)) throw new Error("RPC returned an invalid chain ID.");
    const chainId = Number.parseInt(chainIdHex, 16);
    if (chainId !== chain.chainId) return { ...base, status: "Wrong network", latencyMs, chainId };
    return { ...base, status: "Connected", latencyMs, chainId, readCapable: true, broadcastCapable: true };
  } catch (error) {
    return {
      ...base,
      status: "Unavailable",
      error: redactText(error instanceof Error ? error.message : "RPC unavailable")
    };
  }
}

export async function classifyRpcUrls(urls: string[], chain: ChainConfig): Promise<RpcEndpoint[]> {
  return Promise.all(Array.from(new Set(urls)).map((url) => classifyRpcUrl(url, chain)));
}

export function healthyReadEndpoint(endpoints: RpcEndpoint[]): RpcEndpoint | undefined {
  return endpoints.find((endpoint) => endpoint.status === "Connected" && endpoint.readCapable);
}

export function broadcastEndpoints(endpoints: RpcEndpoint[]): RpcEndpoint[] {
  return endpoints.filter((endpoint) => endpoint.status === "Connected" && endpoint.broadcastCapable);
}

function labelRpc(input: string): string {
  try {
    const host = new URL(input).hostname.replace(/^www\./, "");
    if (host.includes("alchemy")) return "Alchemy";
    if (host.includes("infura")) return "Infura";
    if (host.includes("publicnode")) return "PublicNode";
    if (host.includes("ankr")) return "Ankr";
    if (host.includes("robinhood")) return "Robinhood";
    if (host.includes("base.org")) return "Base";
    return host;
  } catch {
    return "Custom RPC";
  }
}
