import { z } from "zod";
import { Id, IdInput, IsoDate } from "../../schemas/common.js";

export const Chat = z.object({
  chatId: Id,
  type: z.enum(["direct", "group"]),
  name: z.string().nullable(),
  memberIds: z.array(Id),
  createdBy: Id.nullable(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
});

export const CreateChatBody = z
  .object({
    userAId: IdInput,
    userBId: IdInput,
  })
  .strict();

export const CreateChatResponse = z.object({
  chatId: Id,
  created: z.boolean().describe("false when the 1:1 chat already existed"),
  chat: Chat,
});

export const ChatPageResponse = z.object({
  chats: z.array(Chat),
  nextCursor: z.string().nullable(),
});
