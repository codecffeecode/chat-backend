import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { Id, IdInput, IsoDate, errorResponses } from "../../schemas/common.js";
import { createUser, getUser, listUsers, toUserDto } from "./users.service.js";

const User = z.object({ userId: Id, name: z.string(), createdAt: IsoDate });

export const userRoutes: FastifyPluginAsyncZod = (app) => {
  app.post(
    "/users",
    {
      schema: {
        tags: ["users"],
        summary: "Create a user",
        body: z.object({ name: z.string().trim().min(1).max(100) }).strict(),
        response: { 201: User, ...errorResponses },
      },
    },
    async (request, reply) => reply.status(201).send(await createUser(request.body.name)),
  );

  app.get(
    "/users",
    {
      schema: {
        tags: ["users"],
        summary: "List users",
        response: { 200: z.object({ users: z.array(User) }) },
      },
    },
    async () => ({ users: await listUsers() }),
  );

  app.get(
    "/users/:userId",
    {
      schema: {
        tags: ["users"],
        summary: "Get a user",
        params: z.object({ userId: IdInput }),
        response: { 200: User, ...errorResponses },
      },
    },
    async (request) => toUserDto(await getUser(request.params.userId)),
  );

  return Promise.resolve();
};
