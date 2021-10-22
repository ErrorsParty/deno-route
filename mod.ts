export type Handler<
  Params extends Record<string, string> = Record<string, string>,
  Query extends Record<string, string> = Record<string, string>,
  Meta extends Record<string, string> = Record<string, string>,
> = (
  _: { request: Request; query: Query; params: Params; meta: Meta; url: URL },
) => Response | Promise<Response>;

export type Routes = Record<string, Handler>;
export type CompiledRoutes = Map<URLPattern, Handler>;
export type RequestHandler = (request: Request) => Promise<Response>;

function createRequestHandler(
  routes: CompiledRoutes,
  callback: Handler,
): RequestHandler {
  return async (request: Request) => {
    try {
      const url = new URL(request.url);
      for (const [pattern, handler] of routes) {
        if (pattern.test(url + "#" + request.method.toLowerCase())) {
          return await handler(
            {
              request,
              url,
              params: pattern.exec(request.url)?.pathname.groups || {},
              query: fromUrlEncoded(url.searchParams),
              meta: {},
            },
          );
        }
      }
      return await callback({
        request,
        url,
        params: {},
        query: fromUrlEncoded(url.searchParams),
        meta: {},
      });
    } catch (error) {
      return new Response(error.message, {
        status: 500,
        statusText: "internal server error",
      });
    }
  };
}

/**
 * The default request handler to use if no route was found.
 */
export function defaultHandler() {
  return new Response("Page not found", { status: 404 });
}

/**
 * Compile the routes into a request handler.
 * @param routes The routes to compile.
 * @param callback The request handler to call if no matching routes was found.
 */
export function compileRoutes(
  routes: Routes,
  callback: Handler = defaultHandler,
): RequestHandler {
  const map = new Map<URLPattern, Handler>();
  for (let pathname in routes) {
    const originalPathname = pathname;
    const methodDefIndex = pathname.lastIndexOf("#");
    let hash = "*";
    if (methodDefIndex !== -1) {
      hash = pathname.substring(methodDefIndex, pathname.length).toLowerCase();
      pathname = pathname.substring(0, methodDefIndex);
    }
    map.set(new URLPattern({ pathname, hash }), routes[originalPathname]);
  }
  return createRequestHandler(map, callback);
}

/**
 * Respond with JSON data.
 * @param data The data to encode.
 * @param init The response init args.
 */
export function json(data: unknown, init?: ResponseInit): Response {
  init ??= {};
  init.headers ??= {};
  init.headers instanceof Headers
    ? init.headers.set("content-type", "application/json")
    : (init.headers as Record<string, string>)["content-type"] =
      "application/json";
  return new Response(JSON.stringify(data), init);
}

/**
 * Return a redirect response.
 * @param url The uri to redirect to.
 * @param query An optional query object to encode.
 */
export function redirect(
  url: string | URL,
  query: Record<string, string> = {},
) {
  const uri = new URL(url instanceof URL ? url.href : url, "http://localhost");
  for (const key in query) uri.searchParams.set(key, query[key]);
  return new Response("", {
    status: 307,
    headers: {
      Location: uri.origin === "http://localhost"
        ? uri.pathname + uri.search
        : uri.href,
    },
  });
}

/**
 * Encode js data to a url encoded string.
 * @param data The data to encode.
 */
export function toUrlEncoded(
  data: Record<string, string | undefined | null>,
): string {
  const out = new URLSearchParams();
  for (const key in data) {
    if (typeof data[key] !== "string") continue;
    out.set(key, data[key]!);
  }
  return out.toString();
}

/**
 * Decode a url encoded string.
 * @param data The url encoded string to decode.
 */
export function fromUrlEncoded(data: string | URLSearchParams) {
  if (typeof data === "string") {
    data = new URLSearchParams(data);
  }
  if (data instanceof URLSearchParams) {
    const obj: Record<string, string> = {};
    for (const k of data.keys()) {
      obj[k] = data.get(k)!;
    }
    return obj;
  }
  throw new Error(
    "Invalid type of data (" + typeof data + "), expected string!",
  );
}

export type BodyData<X extends Record<string, string>> =
  & X
  & { _body: boolean; _understood: boolean; _data: string; _error?: Error };

export const requestDataHandlers = new Map<
  string,
  // deno-lint-ignore no-explicit-any
  (data: string) => any
>();

requestDataHandlers.set("application/json", (data) => JSON.parse(data));

export const responseDataHandlers = new Map<
  string,
  // deno-lint-ignore no-explicit-any
  (data: any) => string
>();

responseDataHandlers.set("application/json", (data) => JSON.stringify(data));

/**
 * Get the request body into a js object.
 *
 * @note
 *
 * Check the `_error` property to make sure no errors were thrown.
 *
 * Check the `_understood` property to make sure data was decoded successfully.
 *
 * @param request The request.
 */
export async function requestData<
  X extends Record<string, string> = Record<string, string>,
>(request: Request): Promise<BodyData<X>> {
  if (!request.body) {
    return { _body: false, _data: "", _understood: false } as BodyData<X>;
  }
  let text: string;
  try {
    text = await request.text();
  } catch (error) {
    return {
      _body: true,
      _data: "",
      _understood: false,
      _error: error,
    } as BodyData<X>;
  }
  const handler = requestDataHandlers.get(request.headers.get("content-type")!);
  if (!handler) {
    return { _body: true, _data: text, _understood: false } as BodyData<X>;
  }
  try {
    const data = handler(text);
    data._body = true;
    data._data = text;
    data._understood = true;
    return data as BodyData<X>;
  } catch (error) {
    return {
      _body: true,
      _data: text,
      _understood: false,
      _error: error,
    } as BodyData<X>;
  }
}

/**
 * Create a response object with a body that the client will accept.
 * @param request The request object.
 * @param data The data to encode.
 * @param init The response init args.
 */
export function responseData(
  request: Request,
  // deno-lint-ignore no-explicit-any
  data: any,
  init?: ResponseInit,
): Response {
  // Get mime types supported by the client.
  const accept = request.headers.get("accept");
  if (!accept) return json({ error: "no accept header" }, { status: 415 });
  const accepts = accept.split(",").map((str) =>
    str.replace(/\;.*$/g, "").trim()
  );
  // Negotiate the mime type to respond with.
  let negotiatedType: string | undefined;
  for (const dataType of accepts) {
    if (responseDataHandlers.has(dataType)) {
      negotiatedType = dataType;
      break;
    }
  }
  if (!negotiatedType) {
    return json({ error: "couldn't negotiate response data type" }, {
      status: 415,
    });
  }
  const negotiated = responseDataHandlers.get(negotiatedType)!;
  init ??= {};
  init.headers ??= {};
  init.headers instanceof Headers
    ? init.headers.set("content-type", negotiatedType)
    : (init.headers as Record<string, string>)["content-type"] = negotiatedType;
  init.headers = new Headers(init.headers);
  try {
    return new Response(negotiated(data), {});
  } catch (error) {
    try {
      return new Response(
        negotiated({ error: error.message }),
        { status: 500 },
      );
    } catch {
      return json({ error: error.message }, { status: 500 });
    }
  }
}
