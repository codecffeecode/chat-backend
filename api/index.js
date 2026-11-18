import { buildApp } from "../dist/create-app.js";

const ready = buildApp().then(async (app) => {
  await app.ready();
  return app;
});

export default async function handler(req, res) {
  const app = await ready;
  app.server.emit("request", req, res);
}
