import http from "node:http";

export interface UniversalServer {
  port: number;
  stop: (closeActiveConnections?: boolean) => Promise<void> | void;
}

const LOOPBACK_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

/**
 * Gắn CORS headers cho các origin loopback (Swagger UI / DevTools cục bộ).
 */
export function applyLoopbackCors(req: Request, res: Response): Response {
  const origin = req.headers.get("origin");
  if (!origin || !LOOPBACK_ORIGIN_RE.test(origin)) return res;

  const headers = new Headers(res.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("vary", "Origin");
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set("access-control-allow-headers", "Content-Type, Authorization");
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/**
 * Lớp bọc thống nhất HTTP server giữa Bun.serve và Node.js `http.createServer`.
 */
export function serveUniversal(options: {
  hostname: string;
  port: number;
  idleTimeout?: number;
  fetch: (req: Request) => Promise<Response>;
}): UniversalServer {
  if (typeof (globalThis as unknown as { Bun?: { serve: (opts: unknown) => UniversalServer } }).Bun !== "undefined") {
    return (globalThis as unknown as { Bun: { serve: (opts: typeof options) => UniversalServer } }).Bun.serve(options);
  }

  const server = http.createServer(async (nodeReq, nodeRes) => {
    try {
      const url = new URL(nodeReq.url ?? "/", `http://${nodeReq.headers.host || options.hostname}`);
      const bodyChunks: Buffer[] = [];
      for await (const chunk of nodeReq) {
        bodyChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const body = ["GET", "HEAD"].includes(nodeReq.method ?? "") ? undefined : Buffer.concat(bodyChunks);
      const req = new Request(url.href, {
        method: nodeReq.method,
        headers: new Headers(nodeReq.headers as Record<string, string>),
        body,
      });
      const res = await options.fetch(req);
      nodeRes.writeHead(res.status, res.statusText, Object.fromEntries(res.headers.entries()));
      if (res.body) {
        const reader = res.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          nodeRes.write(value);
        }
      }
      nodeRes.end();
    } catch (err: unknown) {
      if (!nodeRes.headersSent) {
        nodeRes.writeHead(500, { "content-type": "application/json" });
        nodeRes.end(JSON.stringify({ error: err instanceof Error ? err.message : String(errorMessage(err)) }));
      }
    }
  });

  server.listen(options.port, options.hostname);
  return {
    port: options.port,
    stop: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

