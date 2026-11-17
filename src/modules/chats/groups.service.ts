import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { db, type Executor, type Transaction } from "../../db/client.js";
import { chatMembers, chats, type ChatRow, type MemberRole } from "../../db/schema.js";
import { badRequest, conflict, forbidden, notFound } from "../../errors.js";
import { assertUsersExist } from "../users/users.service.js";
import { getChat, type ChatDto } from "./chats.service.js";

export const MAX_GROUP_MEMBERS = 100;

export interface MemberDto {
  userId: string;
  role: MemberRole;
  joinedAt: string;
}

export interface ChatDetailDto extends ChatDto {
  members: MemberDto[];
}

export type LeaveResult =
  | { deleted: true; chatId: string }
  | { deleted: false; chatId: string; chat: ChatDetailDto; newOwnerId: string | null };

const canManage = (role: MemberRole) => role === "owner" || role === "admin";

export async function getChatDetail(chatId: string, executor: Executor = db): Promise<ChatDetailDto> {
  const chat = await getChat(chatId, executor);
  const rows = await executor
    .select({ userId: chatMembers.userId, role: chatMembers.role, joinedAt: chatMembers.joinedAt })
    .from(chatMembers)
    .where(eq(chatMembers.chatId, chatId))
    .orderBy(asc(chatMembers.joinedAt), asc(chatMembers.userId));
  return {
    ...chat,
    members: rows.map((r) => ({ userId: r.userId, role: r.role, joinedAt: r.joinedAt.toISOString() })),
  };
}

export async function getMemberRole(chatId: string, userId: string): Promise<MemberRole | null> {
  const [row] = await db
    .select({ role: chatMembers.role })
    .from(chatMembers)
    .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, userId)));
  return row?.role ?? null;
}

async function lockGroup(tx: Transaction, chatId: string): Promise<ChatRow> {
  const [chat] = await tx.select().from(chats).where(eq(chats.id, chatId)).for("update");
  if (!chat) {
    throw notFound("chat_not_found", `Chat ${chatId} does not exist`);
  }
  if (chat.type !== "group") {
    throw badRequest("not_a_group", "This operation is only available for group chats");
  }
  return chat;
}

async function roleOf(tx: Transaction, chatId: string, userId: string): Promise<MemberRole | null> {
  const [row] = await tx
    .select({ role: chatMembers.role })
    .from(chatMembers)
    .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, userId)));
  return row?.role ?? null;
}

async function requireActor(tx: Transaction, chatId: string, actorId: string): Promise<MemberRole> {
  const role = await roleOf(tx, chatId, actorId);
  if (!role) {
    await assertUsersExist([actorId], tx);
    throw forbidden("not_a_member", `User ${actorId} is not a member of chat ${chatId}`);
  }
  return role;
}

async function countMembers(tx: Transaction, chatId: string, role?: MemberRole): Promise<number> {
  const rows = await tx
    .select({ userId: chatMembers.userId })
    .from(chatMembers)
    .where(role ? and(eq(chatMembers.chatId, chatId), eq(chatMembers.role, role)) : eq(chatMembers.chatId, chatId));
  return rows.length;
}

async function touch(tx: Transaction, chatId: string): Promise<void> {
  await tx.update(chats).set({ updatedAt: new Date() }).where(eq(chats.id, chatId));
}

export async function createGroup(input: {
  creatorId: string;
  name: string;
  memberIds: readonly string[];
}): Promise<ChatDetailDto> {
  const others = [...new Set(input.memberIds)].filter((id) => id !== input.creatorId);
  if (others.length === 0) {
    throw badRequest("group_needs_members", "A group needs at least one member besides the creator");
  }
  if (others.length + 1 > MAX_GROUP_MEMBERS) {
    throw badRequest("group_too_large", `A group can have at most ${MAX_GROUP_MEMBERS} members`);
  }

  return db.transaction(async (tx) => {
    await assertUsersExist([input.creatorId, ...others], tx);
    const [chat] = await tx
      .insert(chats)
      .values({ type: "group", name: input.name, createdBy: input.creatorId })
      .returning({ id: chats.id });
    if (!chat) {
      throw new Error("insert returned no row");
    }
    await tx.insert(chatMembers).values([
      { chatId: chat.id, userId: input.creatorId, role: "owner" },
      ...others.map((userId) => ({ chatId: chat.id, userId, role: "member" as const })),
    ]);
    return getChatDetail(chat.id, tx);
  });
}

export async function renameGroup(chatId: string, actorId: string, name: string): Promise<ChatDetailDto> {
  return db.transaction(async (tx) => {
    await lockGroup(tx, chatId);
    const role = await requireActor(tx, chatId, actorId);
    if (!canManage(role)) {
      throw forbidden("insufficient_role", "Only owners and admins can rename the group");
    }
    await tx.update(chats).set({ name, updatedAt: new Date() }).where(eq(chats.id, chatId));
    return getChatDetail(chatId, tx);
  });
}

export async function addMembers(
  chatId: string,
  actorId: string,
  userIds: readonly string[],
): Promise<{ chat: ChatDetailDto; added: string[] }> {
  return db.transaction(async (tx) => {
    await lockGroup(tx, chatId);
    const role = await requireActor(tx, chatId, actorId);
    if (!canManage(role)) {
      throw forbidden("insufficient_role", "Only owners and admins can add members");
    }
    const unique = [...new Set(userIds)];
    await assertUsersExist(unique, tx);

    const existing = await tx
      .select({ userId: chatMembers.userId })
      .from(chatMembers)
      .where(and(eq(chatMembers.chatId, chatId), inArray(chatMembers.userId, unique)));
    const already = new Set(existing.map((r) => r.userId));
    const toAdd = unique.filter((id) => !already.has(id));

    if ((await countMembers(tx, chatId)) + toAdd.length > MAX_GROUP_MEMBERS) {
      throw badRequest("group_too_large", `A group can have at most ${MAX_GROUP_MEMBERS} members`);
    }
    if (toAdd.length > 0) {
      await tx.insert(chatMembers).values(toAdd.map((userId) => ({ chatId, userId, role: "member" as const })));
      await touch(tx, chatId);
    }
    return { chat: await getChatDetail(chatId, tx), added: toAdd };
  });
}

async function transferOwnershipIfNeeded(tx: Transaction, chatId: string, leavingId: string): Promise<string | null> {
  const owners = await tx
    .select({ userId: chatMembers.userId })
    .from(chatMembers)
    .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.role, "owner"), ne(chatMembers.userId, leavingId)));
  if (owners.length > 0) {
    return null;
  }
  const candidates = await tx
    .select({ userId: chatMembers.userId, role: chatMembers.role })
    .from(chatMembers)
    .where(and(eq(chatMembers.chatId, chatId), ne(chatMembers.userId, leavingId)))
    .orderBy(asc(chatMembers.joinedAt), asc(chatMembers.userId));
  const next = candidates.find((c) => c.role === "admin") ?? candidates[0];
  if (!next) {
    return null;
  }
  await tx
    .update(chatMembers)
    .set({ role: "owner" })
    .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, next.userId)));
  return next.userId;
}

export async function leaveGroup(chatId: string, userId: string): Promise<LeaveResult> {
  return db.transaction(async (tx) => {
    await lockGroup(tx, chatId);
    const role = await requireActor(tx, chatId, userId);
    const newOwnerId = role === "owner" ? await transferOwnershipIfNeeded(tx, chatId, userId) : null;

    await tx.delete(chatMembers).where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, userId)));
    if ((await countMembers(tx, chatId)) === 0) {
      await tx.delete(chats).where(eq(chats.id, chatId));
      return { deleted: true, chatId };
    }
    await touch(tx, chatId);
    return { deleted: false, chatId, chat: await getChatDetail(chatId, tx), newOwnerId };
  });
}

export async function removeMember(chatId: string, actorId: string, userId: string): Promise<LeaveResult> {
  if (actorId === userId) {
    return leaveGroup(chatId, userId);
  }
  return db.transaction(async (tx) => {
    await lockGroup(tx, chatId);
    const actorRole = await requireActor(tx, chatId, actorId);
    const targetRole = await roleOf(tx, chatId, userId);
    if (!targetRole) {
      throw notFound("member_not_found", `User ${userId} is not a member of chat ${chatId}`);
    }
    if (!canManage(actorRole)) {
      throw forbidden("insufficient_role", "Only owners and admins can remove members");
    }
    if (targetRole === "owner") {
      throw forbidden("cannot_remove_owner", "Owners cannot be removed; they can leave or be demoted by another owner");
    }
    if (targetRole === "admin" && actorRole !== "owner") {
      throw forbidden("insufficient_role", "Only owners can remove admins");
    }
    await tx.delete(chatMembers).where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, userId)));
    await touch(tx, chatId);
    return { deleted: false, chatId, chat: await getChatDetail(chatId, tx), newOwnerId: null };
  });
}

export async function setMemberRole(
  chatId: string,
  actorId: string,
  userId: string,
  role: MemberRole,
): Promise<ChatDetailDto> {
  return db.transaction(async (tx) => {
    await lockGroup(tx, chatId);
    const actorRole = await requireActor(tx, chatId, actorId);
    if (actorRole !== "owner") {
      throw forbidden("insufficient_role", "Only owners can change member roles");
    }
    const targetRole = await roleOf(tx, chatId, userId);
    if (!targetRole) {
      throw notFound("member_not_found", `User ${userId} is not a member of chat ${chatId}`);
    }
    if (targetRole === role) {
      return getChatDetail(chatId, tx);
    }
    if (targetRole === "owner" && (await countMembers(tx, chatId, "owner")) <= 1) {
      throw conflict("last_owner", "A group must keep at least one owner");
    }
    await tx
      .update(chatMembers)
      .set({ role })
      .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, userId)));
    await touch(tx, chatId);
    return getChatDetail(chatId, tx);
  });
}
