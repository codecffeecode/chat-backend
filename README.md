# Chat Backend

This is a chat backend written in Node.js and TypeScript. It supports 1:1 and group chats.

- **PostgreSQL** stores users, chats and memberships, the relational data.
- **Firebase Firestore** stores messages, read receipts and last-seen pointers, the high-volume data.

Built with Fastify 5, zod 4 for request and response validation, Drizzle ORM, firebase-admin and Vitest. TypeScript runs with every strict flag on, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`. ESLint uses `strictTypeChecked`.

**Live:** https://chat-backend-weld-alpha.vercel.app
**API docs:** https://chat-backend-weld-alpha.vercel.app/docs (Swagger UI, with try-it-out enabled)

The live deployment uses Neon PostgreSQL and a real Firestore project, with demo users already seeded. Get their IDs from `GET /users`.

## Architecture

```
            ┌──────────────── Fastify (zod-validated routes) ────────────────┐
 client ──▶ │ users · chats · groups      │ messages · receipts · last seen  │
            └──────────────┬──────────────┴───────────────┬──────────────────┘
                           │ membership check on          │
                           ▼ every message operation      ▼
                 PostgreSQL (Neon)                  Firestore
                 users, chats, chat_members         chats/{id}, messages, members
```

Postgres is the source of truth for **who belongs to which chat**. Every Firestore operation first checks membership in Postgres. A removed group member immediately loses access, and Firestore never needs its own copy of the membership list.

### PostgreSQL schema

| Table | Key columns |
|---|---|
| `users` | `id uuid`, `name`, `created_at` |
| `chats` | `id`, `type` (`direct` or `group`), `name`, `direct_key` (unique), `created_by`, `created_at`, `updated_at` |
| `chat_members` | `(chat_id, user_id)` primary key, `role` (`owner`, `admin` or `member`), `joined_at`, index on `user_id` |

The `chats_type_shape_ck` check constraint enforces the chat's shape at the database level. A direct chat has a `direct_key` and no name; a group has a name and no `direct_key`.

### Firestore layout

```
chats/{chatId}                         { lastSeq, lastMessageId, lastMessageAt }
chats/{chatId}/messages/{messageId}    { chatId, senderId, text, seq, createdAt, editedAt, deletedAt, readBy: { [userId]: Timestamp } }
chats/{chatId}/members/{userId}        { userId, lastSeenMessageId, lastSeenSeq, lastSeenAt, updatedAt }
```

Every document read from Firestore is validated with zod through a typed `FirestoreDataConverter`, so a malformed document raises an error instead of quietly returning the wrong type. `firestore.rules` denies all client access, because only the Admin SDK on this server talks to Firestore.

## Key design decisions

**1:1 chats are create-or-get and race-safe.**
- Each direct chat stores a `direct_key`: the two user IDs, sorted and joined. The column has a unique constraint.
- Creation runs `INSERT … ON CONFLICT DO NOTHING RETURNING` and then a select, inside one transaction.
- Passing the two users in either order, or with any casing, resolves to the same chat.
- Concurrent requests produce exactly one `201 Created`; every other request gets `200` with the same `chatId`.

**Message ordering uses a per-chat sequence number, not only timestamps.**
- Each send runs a Firestore transaction. It reads `chats/{chatId}.lastSeq`, writes the message with `seq = lastSeq + 1` and a `serverTimestamp()`, and updates the counter.
- The result is a strict, gap-free order (1, 2, 3, …) even for messages sent in the same millisecond or by concurrent writers.
- Clients get stable cursors and a cheap "what's new" check through `after=<seq>`.
- The trade-off is that sends within one chat are serialized on its counter document. Firestore handles roughly one write per second per document comfortably, which is far above what a single conversation produces.

**Message history is paginated by `seq`.**
- `GET /messages` returns the newest `limit` messages, oldest first, which is the order a chat window renders them.
- `before=<nextCursor>` loads older pages, and `after=<seq>` fetches only newer messages, for polling.

**Read receipts are idempotent.**
- A receipt is stored as `readBy.{userId}` on the message, written with `FieldPath` so a user ID can never be interpreted as a nested path.
- The first read time is kept, and repeat calls return `alreadyRead: true`.
- Reading your own message is a no-op that returns `ownMessage: true`.

**Last seen only moves forward.**
- A transaction compares the stored `lastSeenSeq` with the target message's `seq` and writes only if the target is newer.
- Out-of-order requests from multiple devices therefore can't move a user's position backwards. Such a request returns `updated: false` and the current position.
- `GET /chat/:chatId/lastseen` returns every member's position plus the chat's `lastSeq`. Clients can compute unread counts or show "seen by" from that.

**Chat lists sort by activity.**
- Sending a message moves `chats.updated_at` forward in Postgres.
- `GET /user/:userId/chats` uses keyset pagination on `(updated_at, id)`, which stays stable while new messages arrive.

**Group membership changes lock the chat row.**
- Every membership change takes `SELECT … FOR UPDATE` on the chat row first, so concurrent changes to the same group run one at a time.
- The "a group always has an owner" rule is therefore never broken. For example, two owners demoting each other at the same moment results in one success and one 403.

**Validation and errors share one format.**
- Every input is validated by zod: request bodies, path parameters and query strings. Bodies are strict, so unknown keys are rejected. IDs are lowercased and checked as UUIDs.
- Every error has the shape `{ "error": { "code", "message", "details?" } }` with a stable machine-readable `code`.

### Known trade-off

A message send writes to Firestore and then updates `chats.updated_at` in Postgres. The two databases can't share one transaction. If the Postgres update fails, the message is still stored and visible; only the chat-list ordering lags until the next message. At larger scale, I'd move that update to a queue or a Firestore-triggered function.

## API

All IDs are UUIDs except `messageId`, which is a Firestore document ID. Request and response bodies are JSON.

### Core endpoints

| Method | Path | Body or query | Result |
|---|---|---|---|
| `POST` | `/chat/create` | `{ userAId, userBId }` | `201` if created, `200` if it already existed: `{ chatId, created, chat }` |
| `POST` | `/chat/:chatId/message/send` | `{ senderId, text }` | `201` with the message (`messageId`, `seq`, `createdAt`, …) |
| `GET` | `/chat/:chatId/messages` | `?limit=50&before=&after=&userId=` | `{ messages, nextCursor }`, ordered oldest first |
| `POST` | `/chat/:chatId/message/:messageId/read` | `{ userId }` | `{ readAt, alreadyRead, ownMessage, … }` |
| `POST` | `/chat/:chatId/lastseen` | `{ userId, messageId }` | `{ lastSeenMessageId, lastSeenSeq, updated, … }` |
| `GET` | `/user/:userId/chats` | `?limit=20&cursor=` | `{ chats: [{ chatId, type, name, memberIds, … }], nextCursor }` |

### Bonus: group chats

| Method | Path | Body | Who can call it |
|---|---|---|---|
| `POST` | `/chat/group/create` | `{ creatorId, name, memberIds }` | Anyone. The creator becomes owner. |
| `GET` | `/chat/:chatId` | none | Anyone. Returns the chat with members, roles and join times. |
| `PATCH` | `/chat/:chatId` | `{ actorId, name }` | Owner or admin |
| `POST` | `/chat/:chatId/members/add` | `{ actorId, userIds }` | Owner or admin. Existing members are skipped. Maximum 100 members. |
| `POST` | `/chat/:chatId/members/remove` | `{ actorId, userId }` | Owner or admin. Only an owner can remove an admin, and owners can't be removed. |
| `POST` | `/chat/:chatId/members/role` | `{ actorId, userId, role }` | Owner only. The last owner can't be demoted. |
| `POST` | `/chat/:chatId/leave` | `{ userId }` | Any member. See the rules below. |

When the last owner leaves, ownership passes to the longest-standing admin, or to the longest-standing member if there are no admins. When the last member leaves, the group is deleted.

### Bonus: message edit and delete

| Method | Path | Body or query | Rule |
|---|---|---|---|
| `PATCH` | `/chat/:chatId/message/:messageId` | `{ userId, text }` | Sender only. Sets `editedAt`. Deleted messages can't be edited (`409`). |
| `DELETE` | `/chat/:chatId/message/:messageId` | `?userId=` | The sender, or a group owner or admin. A soft delete: `text` is cleared and `deletedAt` set. The message keeps its `seq`. Idempotent. |

### Supporting endpoints

`POST /users {name}`, `GET /users`, `GET /users/:userId`, `GET /chat/:chatId/lastseen`, `GET /health`.

### Error codes

| Status | Codes |
|---|---|
| `400` | `validation_error`, `invalid_json`, `invalid_cursor`, `same_user`, `not_a_group`, `group_needs_members`, `group_too_large` |
| `403` | `not_a_member`, `not_sender`, `insufficient_role`, `cannot_remove_owner` |
| `404` | `user_not_found`, `chat_not_found`, `message_not_found`, `member_not_found`, `route_not_found` |
| `409` | `message_deleted`, `last_owner` |

### Example

```bash
BASE=https://chat-backend-weld-alpha.vercel.app
ALICE=8a6dd9bb-dad9-4bb6-ae9a-dc62d8199a5c
BOB=df6c34aa-4f2e-43de-81d5-56ad0b94672a

CHAT=$(curl -s -H 'content-type: application/json' \
  -d "{\"userAId\":\"$ALICE\",\"userBId\":\"$BOB\"}" $BASE/chat/create | jq -r .chatId)

MSG=$(curl -s -H 'content-type: application/json' \
  -d "{\"senderId\":\"$ALICE\",\"text\":\"Hi Bob\"}" $BASE/chat/$CHAT/message/send | jq -r .messageId)

curl -s "$BASE/chat/$CHAT/messages?limit=50" | jq
curl -s -H 'content-type: application/json' -d "{\"userId\":\"$BOB\"}" $BASE/chat/$CHAT/message/$MSG/read | jq
curl -s -H 'content-type: application/json' -d "{\"userId\":\"$BOB\",\"messageId\":\"$MSG\"}" $BASE/chat/$CHAT/lastseen | jq
curl -s "$BASE/user/$ALICE/chats" | jq
```

`npm run db:seed` creates the demo users Alice, Bob, Carol, Dave and Erin. List them with `GET /users`.

## Running locally

You need Node 22 (see `.nvmrc`), a PostgreSQL database, and either a Firebase project or the Firestore emulator. The emulator requires Java 11 or later and the Firebase CLI.

```bash
nvm use
npm install
cp .env.example .env
npm run db:migrate
npm run db:seed
npm run emulator
npm run dev
```

Run `npm run emulator` in a separate terminal. Fill in `DATABASE_URL` in `.env` before migrating.

To use the emulator, set `FIREBASE_PROJECT_ID=demo-chat-backend` and `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080`. To use a real Firebase project, leave `FIRESTORE_EMULATOR_HOST` empty and set `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY` from a service account key.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `FIREBASE_PROJECT_ID` | Firebase project ID |
| `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` | Service account credentials. Not needed with the emulator. |
| `FIRESTORE_EMULATOR_HOST` | When set, the server uses the emulator |
| `FIRESTORE_COLLECTION_PREFIX` | Optional prefix for every collection name. Tests use it to isolate their data. |
| `PORT`, `LOG_LEVEL`, `NODE_ENV` | Server settings |

## Deployment (Vercel)

The app runs as a single Vercel Function.

- `npm run build` compiles TypeScript into `dist/`.
- `api/index.js` builds the Fastify app once per instance and hands each request to it.
- A rewrite in `vercel.json` routes every path to that function.
- On Vercel the Postgres pool is limited to 5 connections and uses Neon's pooled endpoint.

The Vercel project needs these environment variables:

- `DATABASE_URL`
- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`
- `LOG_LEVEL`

Run migrations from your machine with `npm run db:migrate`, pointed at the production database.

## Tests

```bash
npm run emulator
npm test
npm run typecheck
npm run lint
```

`npm test` needs the emulator running and `DATABASE_URL` set.

The 23 integration tests drive the real app through `app.inject()`, against real Postgres and the Firestore emulator:

- create-or-get, including 8 concurrent creates resolving to one chat
- gap-free ordering under concurrent sends
- `before` and `after` pagination
- read receipt idempotency and own-message handling
- last seen only moving forward
- every group permission rule, ownership transfer, and deleting a group when it empties
- the concurrent last-owner race
- edit and delete permissions, including moderation
- membership and validation errors

Safety and isolation:

- **Never production Firestore.** The suite refuses to start unless `FIRESTORE_EMULATOR_HOST` is set and the project ID starts with `demo-`.
- **Isolated data.** Each run uses a unique `FIRESTORE_COLLECTION_PREFIX` and creates its own users.
- **Cleanup.** Afterwards it deletes every Postgres row and Firestore document it created.
