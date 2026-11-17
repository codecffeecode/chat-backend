import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyInstance } from "fastify";
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";
import { env, isProduction } from "./config.js";
import { badRequest, registerErrorHandler } from "./errors.js";
import { chatRoutes } from "./modules/chats/chats.routes.js";
import { groupRoutes } from "./modules/chats/groups.routes.js";
import { messageRoutes } from "./modules/messages/messages.routes.js";
import { userRoutes } from "./modules/users/users.routes.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: isProduction
      ? { level: env.LOG_LEVEL }
      : { level: env.NODE_ENV === "test" ? "silent" : env.LOG_LEVEL },
    disableRequestLogging: env.NODE_ENV === "test",
  });

  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    if (text.trim() === "") {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(text));
    } catch {
      done(badRequest("invalid_json", "Request body is not valid JSON"), undefined);
    }
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);

  await app.register(cors, { origin: true });
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Chat Backend API",
        description:
          "1:1 and group chats. Users, chats and memberships live in PostgreSQL; messages, read receipts and last-seen pointers live in Firestore.",
        version: "1.0.0",
      },
      tags: [
        { name: "chats", description: "Chat creation and membership" },
        { name: "groups", description: "Group chat creation and management" },
        { name: "messages", description: "Messages, read receipts and last seen" },
        { name: "users", description: "Users and their chats" },
        { name: "system", description: "Health" },
      ],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  app.withTypeProvider<ZodTypeProvider>().get(
    "/health",
    {
      schema: {
        tags: ["system"],
        response: { 200: z.object({ status: z.literal("ok"), environment: z.string() }) },
      },
    },
    () => ({ status: "ok" as const, environment: env.NODE_ENV }),
  );

  await app.register(userRoutes);
  await app.register(chatRoutes);
  await app.register(groupRoutes);
  await app.register(messageRoutes);

  return app;
}
