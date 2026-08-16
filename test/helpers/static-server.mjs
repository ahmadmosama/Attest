import { readFile, stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

const MIME_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
});

function isInside(parentDir, candidatePath) {
  const relative = path.relative(parentDir, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function routeValue(routes, pathname) {
  if (routes instanceof Map) {
    return routes.get(pathname);
  }

  if (routes !== null && typeof routes === "object") {
    return routes[pathname];
  }

  return undefined;
}

function send(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, {
    "cache-control": "no-store",
    ...headers
  });
  response.end(body);
}

async function sendRoute(response, route) {
  if (typeof route === "function") {
    const produced = await route();
    await sendRoute(response, produced);
    return true;
  }

  if (typeof route === "string" || Buffer.isBuffer(route)) {
    send(response, 200, route, { "content-type": "text/html; charset=utf-8" });
    return true;
  }

  if (route !== null && typeof route === "object") {
    send(response, route.status ?? 200, route.body ?? "", route.headers ?? {});
    return true;
  }

  return false;
}

async function staticPathFor(dir, pathname) {
  const decoded = decodeURIComponent(pathname);
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const candidate = path.resolve(dir, relative);

  if (!isInside(dir, candidate)) {
    return null;
  }

  const info = await stat(candidate);
  if (info.isDirectory()) {
    const indexPath = path.join(candidate, "index.html");
    if (!isInside(dir, indexPath)) {
      return null;
    }

    return indexPath;
  }

  return info.isFile() ? candidate : null;
}

function contentType(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

async function handleRequest({ dir, routes }, request, response) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const route = routeValue(routes, url.pathname);

  if (route !== undefined && (await sendRoute(response, route))) {
    return;
  }

  if (dir === undefined) {
    send(response, 404, "not found", { "content-type": "text/plain; charset=utf-8" });
    return;
  }

  try {
    const filePath = await staticPathFor(dir, url.pathname);
    if (filePath === null) {
      send(response, 404, "not found", { "content-type": "text/plain; charset=utf-8" });
      return;
    }

    send(response, 200, await readFile(filePath), { "content-type": contentType(filePath) });
  } catch {
    send(response, 404, "not found", { "content-type": "text/plain; charset=utf-8" });
  }
}

export function startStaticServer({ dir, routes = Object.freeze({}) } = {}) {
  const resolvedDir = dir === undefined ? undefined : path.resolve(dir);
  const server = http.createServer((request, response) => {
    handleRequest({ dir: resolvedDir, routes }, request, response).catch(() => {
      if (!response.headersSent) {
        send(response, 500, "server error", { "content-type": "text/plain; charset=utf-8" });
      } else {
        response.destroy();
      }
    });
  });

  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const address = server.address();
      resolve(
        Object.freeze({
          url: `http://127.0.0.1:${address.port}`,
          close() {
            return new Promise((closeResolve, closeReject) => {
              server.close((error) => {
                if (error === undefined) {
                  closeResolve();
                } else {
                  closeReject(error);
                }
              });
            });
          }
        })
      );
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });
}
