import { beforeAll, describe, expect, it } from "vitest";
import type { ChatPage } from "../src/modules/chats/chats.service.js";
import type {
  LastSeenResult,
  MessageDto,
  MessagePage,
  ReadReceiptResult,
} from "../src/modules/messages/messages.service.js";
import { errorCode, setupHarness } from "./harness.js";

const h = setupHarness();

let alice = "";
let bob = "";
let outsider = "";
let chatId = "";

async function send(senderId: string, text: string): Promise<MessageDto> {
  const res = await h.request("POST", `/chat/${chatId}/message/send`, { senderId, text });
  expect(res.statusCode).toBe(201);
  return res.json<MessageDto>();
}

beforeAll(async () => {
  [alice = "", bob = "", outsider = ""] = await h.users(3);
  const res = await h.request("POST", "/chat/create", { userAId: alice, userBId: bob });
  chatId = res.json<{ chatId: string }>().chatId;
});

describe("send and get messages", () => {
  it("stores a message with a server timestamp and sequence number", async () => {
    const message = await send(alice, "  hello bob  ");
    expect(message).toMatchObject({ chatId, senderId: alice, text: "hello bob", seq: 1 });
    expect(Number.isNaN(Date.parse(message.createdAt))).toBe(false);
    expect(message.readBy).toEqual({});
  });

  it("assigns gap-free sequence numbers under concurrent sends", async () => {
    await Promise.all(Array.from({ length: 10 }, (_, i) => send(i % 2 ? alice : bob, `burst ${i}`)));

    const res = await h.request("GET", `/chat/${chatId}/messages?limit=50`);
    expect(res.statusCode).toBe(200);
    const { messages, nextCursor } = res.json<MessagePage>();
    expect(messages.map((m) => m.seq)).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
    const times = messages.map((m) => Date.parse(m.createdAt));
    expect(times).toEqual([...times].sort((x, y) => x - y));
    expect(nextCursor).toBeNull();
  });

  it("paginates backwards with before and forwards with after", async () => {
    const latest = (await h.request("GET", `/chat/${chatId}/messages?limit=4`)).json<MessagePage>();
    expect(latest.messages.map((m) => m.seq)).toEqual([8, 9, 10, 11]);
    expect(latest.nextCursor).toBe(8);

    const older = (await h.request("GET", `/chat/${chatId}/messages?limit=4&before=8`)).json<MessagePage>();
    expect(older.messages.map((m) => m.seq)).toEqual([4, 5, 6, 7]);

    const newer = (await h.request("GET", `/chat/${chatId}/messages?after=9`)).json<MessagePage>();
    expect(newer.messages.map((m) => m.seq)).toEqual([10, 11]);

    const both = await h.request("GET", `/chat/${chatId}/messages?before=5&after=2`);
    expect(both.statusCode).toBe(400);
  });

  it("moves the chat to the top of each member's chat list", async () => {
    const other = await h.request("POST", "/chat/create", { userAId: alice, userBId: outsider });
    const otherId = other.json<{ chatId: string }>().chatId;
    let list = (await h.request("GET", `/user/${alice}/chats`)).json<ChatPage>();
    expect(list.chats[0]?.chatId).toBe(otherId);

    await send(bob, "bump");
    list = (await h.request("GET", `/user/${alice}/chats`)).json<ChatPage>();
    expect(list.chats[0]?.chatId).toBe(chatId);
  });

  it("rejects non-members, empty text and unknown chats", async () => {
    const outsiderSend = await h.request("POST", `/chat/${chatId}/message/send`, { senderId: outsider, text: "hi" });
    expect(outsiderSend.statusCode).toBe(403);
    expect(errorCode(outsiderSend.body)).toBe("not_a_member");

    const outsiderRead = await h.request("GET", `/chat/${chatId}/messages?userId=${outsider}`);
    expect(outsiderRead.statusCode).toBe(403);

    const empty = await h.request("POST", `/chat/${chatId}/message/send`, { senderId: alice, text: "   " });
    expect(empty.statusCode).toBe(400);
    expect(errorCode(empty.body)).toBe("validation_error");

    const unknown = await h.request("GET", "/chat/f6df9520-1ad1-43e5-8bd6-76d6e40e843f/messages");
    expect(unknown.statusCode).toBe(404);
    expect(errorCode(unknown.body)).toBe("chat_not_found");
  });
});

describe("read receipts", () => {
  it("records the first read time, is idempotent, and ignores the sender", async () => {
    const message = await send(alice, "read me");
    const url = `/chat/${chatId}/message/${message.messageId}/read`;

    const first = (await h.request("POST", url, { userId: bob })).json<ReadReceiptResult>();
    expect(first).toMatchObject({ alreadyRead: false, ownMessage: false });
    expect(first.readAt).not.toBeNull();

    const second = (await h.request("POST", url, { userId: bob })).json<ReadReceiptResult>();
    expect(second).toMatchObject({ alreadyRead: true, readAt: first.readAt });

    const own = (await h.request("POST", url, { userId: alice })).json<ReadReceiptResult>();
    expect(own).toMatchObject({ ownMessage: true, readAt: null });

    const page = (await h.request("GET", `/chat/${chatId}/messages?after=${message.seq - 1}`)).json<MessagePage>();
    expect(page.messages[0]?.readBy).toEqual({ [bob]: first.readAt });
  });

  it("rejects non-members and unknown messages", async () => {
    const message = await send(alice, "private");
    const outsiderRead = await h.request("POST", `/chat/${chatId}/message/${message.messageId}/read`, {
      userId: outsider,
    });
    expect(outsiderRead.statusCode).toBe(403);

    const missing = await h.request("POST", `/chat/${chatId}/message/does-not-exist/read`, { userId: bob });
    expect(missing.statusCode).toBe(404);
    expect(errorCode(missing.body)).toBe("message_not_found");
  });
});

describe("last seen", () => {
  it("only moves forward", async () => {
    const early = await send(alice, "early");
    const late = await send(alice, "late");
    const url = `/chat/${chatId}/lastseen`;

    const forward = await h.request("POST", url, { userId: bob, messageId: late.messageId });
    expect(forward.statusCode).toBe(200);
    expect(forward.json<LastSeenResult>()).toMatchObject({
      updated: true,
      lastSeenMessageId: late.messageId,
      lastSeenSeq: late.seq,
    });

    const backward = (await h.request("POST", url, { userId: bob, messageId: early.messageId })).json<LastSeenResult>();
    expect(backward).toMatchObject({ updated: false, lastSeenMessageId: late.messageId, lastSeenSeq: late.seq });

    const list = (await h.request("GET", url)).json<{ lastSeq: number; members: LastSeenResult[] }>();
    expect(list.lastSeq).toBe(late.seq);
    expect(list.members.find((m) => m.userId === bob)?.lastSeenSeq).toBe(late.seq);
  });

  it("rejects non-members and unknown messages", async () => {
    const message = await send(alice, "x");
    const outsiderSeen = await h.request("POST", `/chat/${chatId}/lastseen`, {
      userId: outsider,
      messageId: message.messageId,
    });
    expect(outsiderSeen.statusCode).toBe(403);

    const missing = await h.request("POST", `/chat/${chatId}/lastseen`, { userId: bob, messageId: "nope" });
    expect(missing.statusCode).toBe(404);
  });
});

describe("edit and delete", () => {
  it("lets only the sender edit, and marks the edit", async () => {
    const message = await send(alice, "typo");
    const url = `/chat/${chatId}/message/${message.messageId}`;

    const notMine = await h.request("PATCH", url, { userId: bob, text: "hijack" });
    expect(notMine.statusCode).toBe(403);
    expect(errorCode(notMine.body)).toBe("not_sender");

    const edited = (await h.request("PATCH", url, { userId: alice, text: "fixed" })).json<MessageDto>();
    expect(edited).toMatchObject({ text: "fixed", seq: message.seq });
    expect(edited.editedAt).not.toBeNull();
  });

  it("soft-deletes for the sender only in 1:1 chats, keeps order, and blocks later edits", async () => {
    const message = await send(alice, "regret");
    const url = `/chat/${chatId}/message/${message.messageId}`;

    const notMine = await h.request("DELETE", `${url}?userId=${bob}`);
    expect(notMine.statusCode).toBe(403);

    const deleted = (await h.request("DELETE", `${url}?userId=${alice}`)).json<MessageDto>();
    expect(deleted).toMatchObject({ text: "", seq: message.seq });
    expect(deleted.deletedAt).not.toBeNull();

    const again = await h.request("DELETE", `${url}?userId=${alice}`);
    expect(again.statusCode).toBe(200);
    expect(again.json<MessageDto>().deletedAt).toBe(deleted.deletedAt);

    const edit = await h.request("PATCH", url, { userId: alice, text: "undo" });
    expect(edit.statusCode).toBe(409);
    expect(errorCode(edit.body)).toBe("message_deleted");

    const page = (await h.request("GET", `/chat/${chatId}/messages?after=${message.seq - 1}`)).json<MessagePage>();
    expect(page.messages[0]).toMatchObject({ messageId: message.messageId, text: "" });
  });
});
