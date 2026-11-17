import { FieldPath, FieldValue, type Timestamp } from "firebase-admin/firestore";
import { firestore } from "../../firebase/firestore.js";
import { notFound } from "../../errors.js";
import { assertMember, getChat, touchChat } from "../chats/chats.service.js";
import {
  chatMetaRef,
  memberStateRef,
  membersRef,
  messagesRef,
  type MemberStateDoc,
  type MessageDoc,
} from "./messages.store.js";

export interface MessageDto {
  messageId: string;
  chatId: string;
  senderId: string;
  text: string;
  seq: number;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  readBy: Record<string, string>;
}

export interface MessagePage {
  messages: MessageDto[];
  nextCursor: number | null;
}

export interface ReadReceiptResult {
  chatId: string;
  messageId: string;
  userId: string;
  readAt: string | null;
  alreadyRead: boolean;
  ownMessage: boolean;
}

export interface LastSeenDto {
  chatId: string;
  userId: string;
  lastSeenMessageId: string;
  lastSeenSeq: number;
  lastSeenAt: string;
  updatedAt: string;
}

export interface LastSeenResult extends LastSeenDto {
  updated: boolean;
}

const iso = (ts: Timestamp): string => ts.toDate().toISOString();
const isoOrNull = (ts: Timestamp | null): string | null => (ts ? iso(ts) : null);

export function toMessageDto(messageId: string, doc: MessageDoc): MessageDto {
  return {
    messageId,
    chatId: doc.chatId,
    senderId: doc.senderId,
    text: doc.text,
    seq: doc.seq,
    createdAt: iso(doc.createdAt),
    editedAt: isoOrNull(doc.editedAt),
    deletedAt: isoOrNull(doc.deletedAt),
    readBy: Object.fromEntries(Object.entries(doc.readBy).map(([userId, at]) => [userId, iso(at)])),
  };
}

function toLastSeenDto(chatId: string, doc: MemberStateDoc): LastSeenDto {
  return {
    chatId,
    userId: doc.userId,
    lastSeenMessageId: doc.lastSeenMessageId,
    lastSeenSeq: doc.lastSeenSeq,
    lastSeenAt: iso(doc.lastSeenAt),
    updatedAt: iso(doc.updatedAt),
  };
}

async function loadMessage(chatId: string, messageId: string): Promise<MessageDto> {
  const snapshot = await messagesRef(chatId).doc(messageId).get();
  const data = snapshot.data();
  if (!data) {
    throw notFound("message_not_found", `Message ${messageId} does not exist in chat ${chatId}`);
  }
  return toMessageDto(snapshot.id, data);
}

export async function sendMessage(chatId: string, senderId: string, text: string): Promise<MessageDto> {
  await assertMember(chatId, senderId);

  const metaRef = chatMetaRef(chatId);
  const messageRef = messagesRef(chatId).doc();

  await firestore().runTransaction(async (tx) => {
    const meta = (await tx.get(metaRef)).data();
    const seq = (meta?.lastSeq ?? 0) + 1;
    tx.set(messageRef, {
      chatId,
      senderId,
      text,
      seq,
      createdAt: FieldValue.serverTimestamp(),
      editedAt: null,
      deletedAt: null,
      readBy: {},
    });
    tx.set(metaRef, {
      lastSeq: seq,
      lastMessageId: messageRef.id,
      lastMessageAt: FieldValue.serverTimestamp(),
    });
  });

  const message = await loadMessage(chatId, messageRef.id);
  await touchChat(chatId, new Date(message.createdAt));
  return message;
}

export async function getMessages(
  chatId: string,
  options: {
    limit: number;
    before?: number | undefined;
    after?: number | undefined;
    userId?: string | undefined;
  },
): Promise<MessagePage> {
  if (options.userId) {
    await assertMember(chatId, options.userId);
  } else {
    await getChat(chatId);
  }
  const ref = messagesRef(chatId);

  if (options.after !== undefined) {
    const snapshot = await ref
      .where("seq", ">", options.after)
      .orderBy("seq", "asc")
      .limit(options.limit + 1)
      .get();
    const docs = snapshot.docs.slice(0, options.limit);
    return {
      messages: docs.map((d) => toMessageDto(d.id, d.data())),
      nextCursor: snapshot.docs.length > options.limit ? (docs.at(-1)?.data().seq ?? null) : null,
    };
  }

  let query = ref.orderBy("seq", "desc").limit(options.limit + 1);
  if (options.before !== undefined) {
    query = ref
      .where("seq", "<", options.before)
      .orderBy("seq", "desc")
      .limit(options.limit + 1);
  }
  const snapshot = await query.get();
  const docs = snapshot.docs.slice(0, options.limit);
  const oldest = docs.at(-1);
  return {
    messages: docs.reverse().map((d) => toMessageDto(d.id, d.data())),
    nextCursor: snapshot.docs.length > options.limit && oldest ? oldest.data().seq : null,
  };
}

export async function markMessageRead(
  chatId: string,
  messageId: string,
  userId: string,
): Promise<ReadReceiptResult> {
  await assertMember(chatId, userId);
  const ref = messagesRef(chatId).doc(messageId);

  const outcome = await firestore().runTransaction(async (tx) => {
    const message = (await tx.get(ref)).data();
    if (!message) {
      throw notFound("message_not_found", `Message ${messageId} does not exist in chat ${chatId}`);
    }
    if (message.senderId === userId) {
      return { ownMessage: true, alreadyRead: false } as const;
    }
    if (message.readBy[userId]) {
      return { ownMessage: false, alreadyRead: true } as const;
    }
    tx.update(ref, new FieldPath("readBy", userId), FieldValue.serverTimestamp());
    return { ownMessage: false, alreadyRead: false } as const;
  });

  const message = await loadMessage(chatId, messageId);
  return {
    chatId,
    messageId,
    userId,
    readAt: message.readBy[userId] ?? null,
    alreadyRead: outcome.alreadyRead,
    ownMessage: outcome.ownMessage,
  };
}

export async function updateLastSeen(
  chatId: string,
  userId: string,
  messageId: string,
): Promise<LastSeenResult> {
  await assertMember(chatId, userId);
  const messageRef = messagesRef(chatId).doc(messageId);
  const stateRef = memberStateRef(chatId, userId);

  const updated = await firestore().runTransaction(async (tx) => {
    const [messageSnap, stateSnap] = await Promise.all([tx.get(messageRef), tx.get(stateRef)]);
    const message = messageSnap.data();
    if (!message) {
      throw notFound("message_not_found", `Message ${messageId} does not exist in chat ${chatId}`);
    }
    const current = stateSnap.data();
    if (current && current.lastSeenSeq >= message.seq) {
      return false;
    }
    tx.set(stateRef, {
      userId,
      lastSeenMessageId: messageId,
      lastSeenSeq: message.seq,
      lastSeenAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return true;
  });

  const state = (await stateRef.get()).data();
  if (!state) {
    throw new Error("last seen state missing after transaction");
  }
  return { ...toLastSeenDto(chatId, state), updated };
}

export async function listLastSeen(chatId: string): Promise<{ lastSeq: number; members: LastSeenDto[] }> {
  await getChat(chatId);
  const [meta, members] = await Promise.all([chatMetaRef(chatId).get(), membersRef(chatId).get()]);
  return {
    lastSeq: meta.data()?.lastSeq ?? 0,
    members: members.docs.map((d) => toLastSeenDto(chatId, d.data())),
  };
}
