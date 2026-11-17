import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { Id, IdInput, IsoDate, errorResponses } from "../../schemas/common.js";
import { Chat } from "./chats.schemas.js";
import {
  MAX_GROUP_MEMBERS,
  addMembers,
  createGroup,
  getChatDetail,
  leaveGroup,
  removeMember,
  renameGroup,
  setMemberRole,
} from "./groups.service.js";

const GroupName = z.string().trim().min(1).max(100);

const ChatDetail = Chat.extend({
  members: z.array(
    z.object({ userId: Id, role: z.enum(["owner", "admin", "member"]), joinedAt: IsoDate }),
  ),
});

const ChatParams = z.object({ chatId: IdInput });

const LeaveResponse = z.object({
  chatId: Id,
  deleted: z.boolean().describe("true when the last member left and the group was deleted"),
  chat: ChatDetail.nullable(),
  newOwnerId: Id.nullable().describe("Set when ownership passed to another member"),
});

function leaveBody(result: Awaited<ReturnType<typeof leaveGroup>>): z.infer<typeof LeaveResponse> {
  return result.deleted
    ? { chatId: result.chatId, deleted: true, chat: null, newOwnerId: null }
    : { chatId: result.chatId, deleted: false, chat: result.chat, newOwnerId: result.newOwnerId };
}

export const groupRoutes: FastifyPluginAsyncZod = (app) => {
  app.get(
    "/chat/:chatId",
    {
      schema: {
        tags: ["chats"],
        summary: "Get a chat with members and roles",
        params: ChatParams,
        response: { 200: ChatDetail, ...errorResponses },
      },
    },
    async (request) => getChatDetail(request.params.chatId),
  );

  app.post(
    "/chat/group/create",
    {
      schema: {
        tags: ["groups"],
        summary: "Create a group chat",
        description: `The creator becomes owner; everyone else joins as member. At most ${MAX_GROUP_MEMBERS} members.`,
        body: z
          .object({
            creatorId: IdInput,
            name: GroupName,
            memberIds: z.array(IdInput).min(1).max(MAX_GROUP_MEMBERS),
          })
          .strict(),
        response: { 201: ChatDetail, ...errorResponses },
      },
    },
    async (request, reply) => reply.status(201).send(await createGroup(request.body)),
  );

  app.patch(
    "/chat/:chatId",
    {
      schema: {
        tags: ["groups"],
        summary: "Rename a group (owner or admin)",
        params: ChatParams,
        body: z.object({ actorId: IdInput, name: GroupName }).strict(),
        response: { 200: ChatDetail, ...errorResponses },
      },
    },
    async (request) => renameGroup(request.params.chatId, request.body.actorId, request.body.name),
  );

  app.post(
    "/chat/:chatId/members/add",
    {
      schema: {
        tags: ["groups"],
        summary: "Add members to a group (owner or admin)",
        description: "Users who are already members are ignored.",
        params: ChatParams,
        body: z
          .object({ actorId: IdInput, userIds: z.array(IdInput).min(1).max(MAX_GROUP_MEMBERS) })
          .strict(),
        response: {
          200: z.object({ chat: ChatDetail, added: z.array(Id) }),
          ...errorResponses,
        },
      },
    },
    async (request) => addMembers(request.params.chatId, request.body.actorId, request.body.userIds),
  );

  app.post(
    "/chat/:chatId/members/remove",
    {
      schema: {
        tags: ["groups"],
        summary: "Remove a member from a group",
        description:
          "Owners and admins can remove members; only owners can remove admins; owners cannot be removed. Removing yourself is the same as leaving.",
        params: ChatParams,
        body: z.object({ actorId: IdInput, userId: IdInput }).strict(),
        response: { 200: LeaveResponse, ...errorResponses },
      },
    },
    async (request) =>
      leaveBody(await removeMember(request.params.chatId, request.body.actorId, request.body.userId)),
  );

  app.post(
    "/chat/:chatId/members/role",
    {
      schema: {
        tags: ["groups"],
        summary: "Change a member's role (owner only)",
        description: "The last owner cannot be demoted.",
        params: ChatParams,
        body: z
          .object({ actorId: IdInput, userId: IdInput, role: z.enum(["owner", "admin", "member"]) })
          .strict(),
        response: { 200: ChatDetail, ...errorResponses },
      },
    },
    async (request) =>
      setMemberRole(request.params.chatId, request.body.actorId, request.body.userId, request.body.role),
  );

  app.post(
    "/chat/:chatId/leave",
    {
      schema: {
        tags: ["groups"],
        summary: "Leave a group",
        description:
          "If the last owner leaves, ownership passes to the longest-standing admin, or the longest-standing member. If the last member leaves, the group is deleted.",
        params: ChatParams,
        body: z.object({ userId: IdInput }).strict(),
        response: { 200: LeaveResponse, ...errorResponses },
      },
    },
    async (request) => leaveBody(await leaveGroup(request.params.chatId, request.body.userId)),
  );

  return Promise.resolve();
};
