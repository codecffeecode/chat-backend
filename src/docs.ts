import type { FastifyInstance } from "fastify";

const SWAGGER_UI_VERSION = "5.35.0";

const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Chat Backend API</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://cdn.jsdelivr.net/npm/swagger-ui-dist@${SWAGGER_UI_VERSION}/swagger-ui-bundle.js" crossorigin></script>
    <script>
      window.ui = SwaggerUIBundle({ url: "/docs/json", dom_id: "#swagger-ui", deepLinking: true, tryItOutEnabled: true });
    </script>
  </body>
</html>`;

export function registerDocs(app: FastifyInstance): void {
  app.get("/", { schema: { hide: true } }, (_request, reply) => reply.redirect("/docs"));
  app.get("/docs", { schema: { hide: true } }, (_request, reply) => reply.type("text/html").send(page));
  app.get("/docs/json", { schema: { hide: true } }, () => app.swagger());
}
