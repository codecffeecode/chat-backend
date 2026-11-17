import { z } from "zod";
import { Id, IdInput, IsoDate, Limit } from "../../schemas/common.js";

export const ChatParams = z.object({ chatId: IdInput });

export const MessageParams = z.object({
  chatId: IdInput,
  messageId: z.string().trim().min(1).max(128).describe("Firestore message ID"),
});

export const Message = z.object({
  messageId: z.string(),
  chatId: Id,
  senderId: Id,
  text: z.string(),
  seq: z.number().int().positive().describe("Per-chat sequence number assigned by the server; defines message order"),
  createdAt: IsoDate.describe("Firestore server timestamp"),
  editedAt: IsoDate.nullable(),
  deletedAt: IsoDate.nullable(),
  readBy: z.record(z.string(), IsoDate).describe("userId -> first read time"),
});

export const SendMessageBody = z
  .object({
    senderId: IdInput,
    text: z.string().trim().min(1, "text must not be empty").max(4000),
  })
  .strict();

export const MessagesQuery = z
  .object({
    limit: Limit(50, 100),
    before: z.coerce.number().int().positive().optional().describe("Return messages with seq < before (older page)"),
    after: z.coerce.number().int().nonnegative().optional().describe("Return messages with seq > after (newer messages)"),
    userId: IdInput.optional().describe("If set, the caller must be a member of the chat"),
  })
  .refine((q) => q.before === undefined || q.after === undefined, {
    message: "Use either before or after, not both",
    path: ["before"],
  });

export const MessagePage = z.object({
  messages: z.array(Message).describe("Oldest first"),
  nextCursor: z
    .number()
    .int()
    .nullable()
    .describe("Pass as before (or after, when paging forward) to continue; null when there are no more"),
});

export const UserBody = z.object({ userId: IdInput }).strict();

export const ReadReceipt = z.object({
  chatId: Id,
  messageId: z.string(),
  userId: Id,
  readAt: IsoDate.nullable(),
  alreadyRead: z.boolean(),
  ownMessage: z.boolean().describe("true when the reader sent the message; no receipt is stored"),
});

export const LastSeenBody = z
  .object({
    userId: IdInput,
    messageId: z.string().trim().min(1).max(128),
  })
  .strict();

export const LastSeen = z.object({
  chatId: Id,
  userId: Id,
  lastSeenMessageId: z.string(),
  lastSeenSeq: z.number().int().positive(),
  lastSeenAt: IsoDate,
  updatedAt: IsoDate,
});

export const LastSeenResult = LastSeen.extend({
  updated: z.boolean().describe("false when the stored pointer was already at or past this message"),
});

export const LastSeenList = z.object({
  lastSeq: z.number().int().nonnegative(),
  members: z.array(LastSeen),
});
