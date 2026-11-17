import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { IdInput, Limit, errorResponses } from "../../schemas/common.js";
import { ChatPageResponse, CreateChatBody, CreateChatResponse } from "./chats.schemas.js";
import { createOrGetDirectChat, listUserChats } from "./chats.service.js";

export const chatRoutes: FastifyPluginAsyncZod = (app) => {
  app.post(
    "/chat/create",
    {
      schema: {
        tags: ["chats"],
        summary: "Create or get the 1:1 chat between two users",
        description:
          "Idempotent: the same pair of users (in any order) always maps to one chat. Returns 201 when a chat was created and 200 when it already existed.",
        body: CreateChatBody,
        response: { 200: CreateChatResponse, 201: CreateChatResponse, ...errorResponses },
      },
    },
    async (request, reply) => {
      const { chat, created } = await createOrGetDirectChat(
        request.body.userAId,
        request.body.userBId,
      );
      return reply.status(created ? 201 : 200).send({ chatId: chat.chatId, created, chat });
    },
  );

  app.get(
    "/user/:userId/chats",
    {
      schema: {
        tags: ["users"],
        summary: "List a user's chats with member IDs",
        description: "Most recently active first. Pass nextCursor back as cursor to get the next page.",
        params: z.object({ userId: IdInput }),
        querystring: z.object({
          limit: Limit(20, 100),
          cursor: z.string().optional(),
        }),
        response: { 200: ChatPageResponse, ...errorResponses },
      },
    },
    async (request) =>
      listUserChats(request.params.userId, {
        limit: request.query.limit,
        cursor: request.query.cursor,
      }),
  );

  return Promise.resolve();
};
