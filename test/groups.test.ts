import { describe, expect, it } from "vitest";
import type { ChatDetailDto } from "../src/modules/chats/groups.service.js";
import type { MessageDto } from "../src/modules/messages/messages.service.js";
import { errorCode, setupHarness } from "./harness.js";

interface LeaveBody {
  chatId: string;
  deleted: boolean;
  chat: ChatDetailDto | null;
  newOwnerId: string | null;
}

const h = setupHarness();

function roles(chat: ChatDetailDto | null | undefined): Record<string, string> {
  return Object.fromEntries((chat?.members ?? []).map((m) => [m.userId, m.role]));
}

async function group(creatorId: string, memberIds: string[], name = "Team"): Promise<ChatDetailDto> {
  const res = await h.request("POST", "/chat/group/create", { creatorId, name, memberIds });
  expect(res.statusCode).toBe(201);
  return res.json<ChatDetailDto>();
}

describe("group creation", () => {
  it("makes the creator owner and dedupes members", async () => {
    const [owner, b, c] = await h.users(3);
    if (!owner || !b || !c) throw new Error("users missing");

    const chat = await group(owner, [b, c, c, owner]);
    expect(chat).toMatchObject({ type: "group", name: "Team", createdBy: owner });
    expect(roles(chat)).toEqual({ [owner]: "owner", [b]: "member", [c]: "member" });

    const list = await h.request("GET", `/user/${b}/chats`);
    expect(list.json<{ chats: { chatId: string }[] }>().chats.map((x) => x.chatId)).toContain(chat.chatId);
  });

  it("rejects groups with nobody else, blank names and unknown users", async () => {
    const owner = await h.user();
    const solo = await h.request("POST", "/chat/group/create", { creatorId: owner, name: "Solo", memberIds: [owner] });
    expect(errorCode(solo.body)).toBe("group_needs_members");

    const blank = await h.request("POST", "/chat/group/create", { creatorId: owner, name: "  ", memberIds: [owner] });
    expect(errorCode(blank.body)).toBe("validation_error");

    const unknown = await h.request("POST", "/chat/group/create", {
      creatorId: owner,
      name: "Ghosts",
      memberIds: ["f6df9520-1ad1-43e5-8bd6-76d6e40e843f"],
    });
    expect(unknown.statusCode).toBe(404);
  });
});

describe("group management", () => {
  it("enforces owner/admin/member permissions", async () => {
    const [owner, admin, member, extra] = await h.users(4);
    if (!owner || !admin || !member || !extra) throw new Error("users missing");
    const { chatId } = await group(owner, [admin, member]);

    const memberRename = await h.request("PATCH", `/chat/${chatId}`, { actorId: member, name: "Hacked" });
    expect(memberRename.statusCode).toBe(403);
    expect(errorCode(memberRename.body)).toBe("insufficient_role");

    const promote = await h.request("POST", `/chat/${chatId}/members/role`, {
      actorId: owner,
      userId: admin,
      role: "admin",
    });
    expect(roles(promote.json<ChatDetailDto>())[admin]).toBe("admin");

    const adminPromotes = await h.request("POST", `/chat/${chatId}/members/role`, {
      actorId: admin,
      userId: member,
      role: "admin",
    });
    expect(adminPromotes.statusCode).toBe(403);

    const renamed = await h.request("PATCH", `/chat/${chatId}`, { actorId: admin, name: "Core" });
    expect(renamed.json<ChatDetailDto>().name).toBe("Core");

    const added = await h.request("POST", `/chat/${chatId}/members/add`, { actorId: admin, userIds: [extra, member] });
    expect(added.json<{ added: string[] }>().added).toEqual([extra]);

    const memberRemoves = await h.request("POST", `/chat/${chatId}/members/remove`, { actorId: member, userId: extra });
    expect(memberRemoves.statusCode).toBe(403);

    const removeOwner = await h.request("POST", `/chat/${chatId}/members/remove`, { actorId: admin, userId: owner });
    expect(errorCode(removeOwner.body)).toBe("cannot_remove_owner");

    const removed = await h.request("POST", `/chat/${chatId}/members/remove`, { actorId: admin, userId: extra });
    expect(Object.keys(roles(removed.json<LeaveBody>().chat))).not.toContain(extra);

    const removedSends = await h.request("POST", `/chat/${chatId}/message/send`, { senderId: extra, text: "hi" });
    expect(removedSends.statusCode).toBe(403);

    const demoteLastOwner = await h.request("POST", `/chat/${chatId}/members/role`, {
      actorId: owner,
      userId: owner,
      role: "member",
    });
    expect(demoteLastOwner.statusCode).toBe(409);
    expect(errorCode(demoteLastOwner.body)).toBe("last_owner");
  });

  it("transfers ownership when the last owner leaves and deletes the group when empty", async () => {
    const [owner, member, admin] = await h.users(3);
    if (!owner || !member || !admin) throw new Error("users missing");
    const { chatId } = await group(owner, [member, admin]);
    await h.request("POST", `/chat/${chatId}/members/role`, { actorId: owner, userId: admin, role: "admin" });

    const ownerLeaves = (await h.request("POST", `/chat/${chatId}/leave`, { userId: owner })).json<LeaveBody>();
    expect(ownerLeaves).toMatchObject({ deleted: false, newOwnerId: admin });
    expect(roles(ownerLeaves.chat)).toEqual({ [member]: "member", [admin]: "owner" });

    const adminLeaves = (await h.request("POST", `/chat/${chatId}/leave`, { userId: admin })).json<LeaveBody>();
    expect(adminLeaves.newOwnerId).toBe(member);

    const lastLeaves = (await h.request("POST", `/chat/${chatId}/leave`, { userId: member })).json<LeaveBody>();
    expect(lastLeaves).toMatchObject({ deleted: true, chat: null });

    const gone = await h.request("GET", `/chat/${chatId}`);
    expect(gone.statusCode).toBe(404);
  });

  it("never leaves a group without an owner under concurrent demotions", async () => {
    const [a, b, c] = await h.users(3);
    if (!a || !b || !c) throw new Error("users missing");
    const { chatId } = await group(a, [b, c]);
    await h.request("POST", `/chat/${chatId}/members/role`, { actorId: a, userId: b, role: "owner" });

    const results = await Promise.all([
      h.request("POST", `/chat/${chatId}/members/role`, { actorId: a, userId: b, role: "member" }),
      h.request("POST", `/chat/${chatId}/members/role`, { actorId: b, userId: a, role: "member" }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 403].sort());

    const chat = (await h.request("GET", `/chat/${chatId}`)).json<ChatDetailDto>();
    expect(chat.members.filter((m) => m.role === "owner")).toHaveLength(1);
  });

  it("rejects group operations on 1:1 chats", async () => {
    const [a, b] = await h.users(2);
    if (!a || !b) throw new Error("users missing");
    const direct = await h.request("POST", "/chat/create", { userAId: a, userBId: b });
    const { chatId } = direct.json<{ chatId: string }>();

    const res = await h.request("POST", `/chat/${chatId}/leave`, { userId: a });
    expect(res.statusCode).toBe(400);
    expect(errorCode(res.body)).toBe("not_a_group");
  });
});

describe("group message moderation", () => {
  it("lets owners and admins delete anyone's message, but not plain members", async () => {
    const [owner, member, other] = await h.users(3);
    if (!owner || !member || !other) throw new Error("users missing");
    const { chatId } = await group(owner, [member, other]);

    const sent = await h.request("POST", `/chat/${chatId}/message/send`, { senderId: other, text: "spam" });
    const { messageId } = sent.json<MessageDto>();

    const byMember = await h.request("DELETE", `/chat/${chatId}/message/${messageId}?userId=${member}`);
    expect(byMember.statusCode).toBe(403);

    const byOwner = await h.request("DELETE", `/chat/${chatId}/message/${messageId}?userId=${owner}`);
    expect(byOwner.statusCode).toBe(200);
    expect(byOwner.json<MessageDto>().deletedAt).not.toBeNull();
  });
});
