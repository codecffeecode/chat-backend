import { describe, expect, it } from "vitest";
import type { ChatDto, ChatPage } from "../src/modules/chats/chats.service.js";
import { errorCode, setupHarness } from "./harness.js";

interface CreateChatBody {
  chatId: string;
  created: boolean;
  chat: ChatDto;
}

const h = setupHarness();

describe("POST /chat/create", () => {
  it("creates a 1:1 chat, then returns the same chat for either order and any casing", async () => {
    const [a, b] = await h.users(2);
    if (!a || !b) throw new Error("users missing");

    const first = await h.request("POST", "/chat/create", { userAId: a, userBId: b });
    expect(first.statusCode).toBe(201);
    const created = first.json<CreateChatBody>();
    expect(created.created).toBe(true);
    expect(created.chat.type).toBe("direct");
    expect([...created.chat.memberIds].sort()).toEqual([a, b].sort());

    const again = await h.request("POST", "/chat/create", { userAId: b.toUpperCase(), userBId: a });
    expect(again.statusCode).toBe(200);
    expect(again.json<CreateChatBody>()).toMatchObject({ chatId: created.chatId, created: false });
  });

  it("is idempotent under concurrent requests", async () => {
    const [a, b] = await h.users(2);
    if (!a || !b) throw new Error("users missing");

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        h.request("POST", "/chat/create", i % 2 ? { userAId: a, userBId: b } : { userAId: b, userBId: a }),
      ),
    );
    const statuses = results.map((r) => r.statusCode).sort();
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
    expect(new Set(results.map((r) => r.json<CreateChatBody>().chatId)).size).toBe(1);
  });

  it("rejects chatting with yourself, unknown users and invalid input", async () => {
    const a = await h.user();
    const self = await h.request("POST", "/chat/create", { userAId: a, userBId: a });
    expect(self.statusCode).toBe(400);
    expect(errorCode(self.body)).toBe("same_user");

    const unknown = await h.request("POST", "/chat/create", {
      userAId: a,
      userBId: "f6df9520-1ad1-43e5-8bd6-76d6e40e843f",
    });
    expect(unknown.statusCode).toBe(404);
    expect(errorCode(unknown.body)).toBe("user_not_found");

    const invalid = await h.request("POST", "/chat/create", { userAId: "nope" });
    expect(invalid.statusCode).toBe(400);
    expect(errorCode(invalid.body)).toBe("validation_error");
  });
});

describe("GET /user/:userId/chats", () => {
  it("lists chats with member ids, most recent first, with cursor pagination", async () => {
    const [me, x, y, z] = await h.users(4);
    if (!me || !x || !y || !z) throw new Error("users missing");

    const chatIds: string[] = [];
    for (const other of [x, y, z]) {
      const res = await h.request("POST", "/chat/create", { userAId: me, userBId: other });
      chatIds.push(res.json<CreateChatBody>().chatId);
    }

    const page1 = await h.request("GET", `/user/${me}/chats?limit=2`);
    expect(page1.statusCode).toBe(200);
    const p1 = page1.json<ChatPage>();
    expect(p1.chats.map((c) => c.chatId)).toEqual([chatIds[2], chatIds[1]]);
    expect(p1.chats[0]?.memberIds).toContain(me);
    expect(p1.nextCursor).not.toBeNull();

    const page2 = await h.request("GET", `/user/${me}/chats?limit=2&cursor=${p1.nextCursor ?? ""}`);
    const p2 = page2.json<ChatPage>();
    expect(p2.chats.map((c) => c.chatId)).toEqual([chatIds[0]]);
    expect(p2.nextCursor).toBeNull();
  });

  it("returns 404 for unknown users and 400 for a bad cursor", async () => {
    const missing = await h.request("GET", "/user/f6df9520-1ad1-43e5-8bd6-76d6e40e843f/chats");
    expect(missing.statusCode).toBe(404);

    const me = await h.user();
    const bad = await h.request("GET", `/user/${me}/chats?cursor=garbage`);
    expect(bad.statusCode).toBe(400);
    expect(errorCode(bad.body)).toBe("invalid_cursor");
  });
});
