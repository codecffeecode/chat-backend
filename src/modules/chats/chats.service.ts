import { and, desc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import { db, type Executor } from "../../db/client.js";
import { chatMembers, chats, type ChatType } from "../../db/schema.js";
import { badRequest, forbidden, notFound } from "../../errors.js";
import { decodeCursor, encodeCursor } from "../../lib/cursor.js";
import { assertUsersExist, getUser } from "../users/users.service.js";

export interface ChatDto {
  chatId: string;
  type: ChatType;
  name: string | null;
  memberIds: string[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateDirectChatResult {
  chat: ChatDto;
  created: boolean;
}

export function directKeyFor(userAId: string, userBId: string): string {
  return [userAId.toLowerCase(), userBId.toLowerCase()].sort().join(":");
}

const memberIdsSql = sql<string[]>`array_agg(${chatMembers.userId} order by ${chatMembers.joinedAt}, ${chatMembers.userId})::text[]`;

async function loadChat(chatId: string, executor: Executor = db): Promise<ChatDto | null> {
  const [row] = await executor
    .select({
      id: chats.id,
      type: chats.type,
      name: chats.name,
      createdBy: chats.createdBy,
      createdAt: chats.createdAt,
      updatedAt: chats.updatedAt,
      memberIds: memberIdsSql,
    })
    .from(chats)
    .innerJoin(chatMembers, eq(chatMembers.chatId, chats.id))
    .where(eq(chats.id, chatId))
    .groupBy(chats.id);
  if (!row) {
    return null;
  }
  return {
    chatId: row.id,
    type: row.type,
    name: row.name,
    memberIds: row.memberIds,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getChat(chatId: string, executor: Executor = db): Promise<ChatDto> {
  const chat = await loadChat(chatId, executor);
  if (!chat) {
    throw notFound("chat_not_found", `Chat ${chatId} does not exist`);
  }
  return chat;
}

export async function assertMember(chatId: string, userId: string): Promise<ChatDto> {
  const chat = await getChat(chatId);
  if (!chat.memberIds.includes(userId)) {
    await getUser(userId);
    throw forbidden("not_a_member", `User ${userId} is not a member of chat ${chatId}`);
  }
  return chat;
}

export async function createOrGetDirectChat(
  userAId: string,
  userBId: string,
): Promise<CreateDirectChatResult> {
  if (userAId.toLowerCase() === userBId.toLowerCase()) {
    throw badRequest("same_user", "userAId and userBId must be different users");
  }
  const directKey = directKeyFor(userAId, userBId);

  return db.transaction(async (tx) => {
    await assertUsersExist([userAId, userBId], tx);

    const [inserted] = await tx
      .insert(chats)
      .values({ type: "direct", directKey, createdBy: userAId })
      .onConflictDoNothing({ target: chats.directKey })
      .returning({ id: chats.id });

    if (inserted) {
      await tx.insert(chatMembers).values([
        { chatId: inserted.id, userId: userAId, role: "member" },
        { chatId: inserted.id, userId: userBId, role: "member" },
      ]);
      return { chat: await getChat(inserted.id, tx), created: true };
    }

    const [existing] = await tx
      .select({ id: chats.id })
      .from(chats)
      .where(eq(chats.directKey, directKey));
    if (!existing) {
      throw new Error(`direct chat ${directKey} vanished during create-or-get`);
    }
    return { chat: await getChat(existing.id, tx), created: false };
  });
}

const ChatListCursor = z.object({ u: z.iso.datetime(), i: z.uuid() });

export interface ChatPage {
  chats: ChatDto[];
  nextCursor: string | null;
}

export async function listUserChats(
  userId: string,
  options: { limit: number; cursor?: string | undefined },
): Promise<ChatPage> {
  await getUser(userId);
  const me = alias(chatMembers, "me");
  const cursor = options.cursor ? decodeCursor(options.cursor, ChatListCursor) : null;

  const rows = await db
    .select({
      id: chats.id,
      type: chats.type,
      name: chats.name,
      createdBy: chats.createdBy,
      createdAt: chats.createdAt,
      updatedAt: chats.updatedAt,
      memberIds: memberIdsSql,
    })
    .from(me)
    .innerJoin(chats, eq(chats.id, me.chatId))
    .innerJoin(chatMembers, eq(chatMembers.chatId, chats.id))
    .where(
      and(
        eq(me.userId, userId),
        cursor
          ? sql`(${chats.updatedAt}, ${chats.id}) < (${cursor.u}::timestamptz, ${cursor.i}::uuid)`
          : undefined,
      ),
    )
    .groupBy(chats.id)
    .orderBy(desc(chats.updatedAt), desc(chats.id))
    .limit(options.limit + 1);

  const page = rows.slice(0, options.limit);
  const last = page.at(-1);
  return {
    chats: page.map((row) => ({
      chatId: row.id,
      type: row.type,
      name: row.name,
      memberIds: row.memberIds,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
    nextCursor:
      rows.length > options.limit && last
        ? encodeCursor({ u: last.updatedAt.toISOString(), i: last.id })
        : null,
  };
}

export async function touchChat(chatId: string, at: Date = new Date()): Promise<void> {
  await db
    .update(chats)
    .set({ updatedAt: at })
    .where(and(eq(chats.id, chatId), sql`${chats.updatedAt} < ${at.toISOString()}::timestamptz`));
}
