# Route

A simple deno router that takes advantage of `URLPattern`s.

## Examples

```ts
import { compileRoutes } from "https://deno.land/x/route/mod.ts";

const handleRequest = compileRoutes(
  {
    "/": () => new Response("hello from all http methods"),
    // The hash property is used to target http method:
    // /<pathname>#<http method>
    "/hello#post": () => new Response("hello from http post method"),
  },
  () => new Response("404", { status: 404 }),
);

const listener = Deno.listen({ hostname: "localhost", port: 3000 });

console.log("Listening on http://localhost:3000");

async function handleConn(conn: Deno.Conn) {
  for await (const event of Deno.serveHttp(conn)) {
    await event.respondWith(await handleRequest(event.request)).catch(
      console.error,
    );
  }
}

for await (const conn of listener) handleConn(conn).catch(console.error);
```
