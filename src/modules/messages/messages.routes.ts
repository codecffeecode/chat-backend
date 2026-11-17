import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { errorResponses } from "../../schemas/common.js";
import {
  ChatParams,
  LastSeenBody,
  LastSeenList,
  LastSeenResult,
  Message,
  MessagePage,
  MessageParams,
  MessagesQuery,
  ReadReceipt,
  SendMessageBody,
  UserBody,
} from "./messages.schemas.js";
import {
  getMessages,
  listLastSeen,
  markMessageRead,
  sendMessage,
  updateLastSeen,
} from "./messages.service.js";

export const messageRoutes: FastifyPluginAsyncZod = (app) => {
  app.post(
    "/chat/:chatId/message/send",
    {
      schema: {
        tags: ["messages"],
        summary: "Send a message",
        description:
          "The sender must be a member of the chat (checked in PostgreSQL). The message is stored in Firestore with a server timestamp and a per-chat sequence number.",
        params: ChatParams,
        body: SendMessageBody,
        response: { 201: Message, ...errorResponses },
      },
    },
    async (request, reply) =>
      reply
        .status(201)
        .send(await sendMessage(request.params.chatId, request.body.senderId, request.body.text)),
  );

  app.get(
    "/chat/:chatId/messages",
    {
      schema: {
        tags: ["messages"],
        summary: "Get messages ordered by timestamp",
        description:
          "Returns the latest `limit` messages, oldest first. Use `before=<nextCursor>` to load older pages, or `after=<seq>` to fetch only messages newer than the last one you have.",
        params: ChatParams,
        querystring: MessagesQuery,
        response: { 200: MessagePage, ...errorResponses },
      },
    },
    async (request) => getMessages(request.params.chatId, request.query),
  );

  app.post(
    "/chat/:chatId/message/:messageId/read",
    {
      schema: {
        tags: ["messages"],
        summary: "Mark a message as read",
        description:
          "Idempotent: the first read time is kept. Reading your own message is a no-op.",
        params: MessageParams,
        body: UserBody,
        response: { 200: ReadReceipt, ...errorResponses },
      },
    },
    async (request) =>
      markMessageRead(request.params.chatId, request.params.messageId, request.body.userId),
  );

  app.post(
    "/chat/:chatId/lastseen",
    {
      schema: {
        tags: ["messages"],
        summary: "Update a user's last seen message",
        description:
          "Only moves forward: a message older than the stored one leaves the pointer unchanged (updated=false).",
        params: ChatParams,
        body: LastSeenBody,
        response: { 200: LastSeenResult, ...errorResponses },
      },
    },
    async (request) =>
      updateLastSeen(request.params.chatId, request.body.userId, request.body.messageId),
  );

  app.get(
    "/chat/:chatId/lastseen",
    {
      schema: {
        tags: ["messages"],
        summary: "Get every member's last seen message",
        params: ChatParams,
        response: { 200: LastSeenList, ...errorResponses },
      },
    },
    async (request) => listLastSeen(request.params.chatId),
  );

  return Promise.resolve();
};
