import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true, precision: 3, mode: "date" });

export const chatType = pgEnum("chat_type", ["direct", "group"]);
export const memberRole = pgEnum("member_role", ["owner", "admin", "member"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

export const chats = pgTable(
  "chats",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: chatType("type").notNull(),
    name: text("name"),
    directKey: text("direct_key").unique("chats_direct_key_uq"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [
    check(
      "chats_type_shape_ck",
      sql`(${t.type} = 'direct' and ${t.directKey} is not null and ${t.name} is null)
        or (${t.type} = 'group' and ${t.directKey} is null and ${t.name} is not null)`,
    ),
  ],
);

export const chatMembers = pgTable(
  "chat_members",
  {
    chatId: uuid("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRole("role").notNull().default("member"),
    joinedAt: timestamptz("joined_at").notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: "chat_members_pk", columns: [t.chatId, t.userId] }),
    index("chat_members_user_idx").on(t.userId),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type ChatRow = typeof chats.$inferSelect;
export type ChatMemberRow = typeof chatMembers.$inferSelect;
export type ChatType = (typeof chatType.enumValues)[number];
export type MemberRole = (typeof memberRole.enumValues)[number];
