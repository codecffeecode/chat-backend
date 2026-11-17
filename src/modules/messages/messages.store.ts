import {
  Timestamp,
  type CollectionReference,
  type DocumentData,
  type DocumentReference,
  type FirestoreDataConverter,
  type QueryDocumentSnapshot,
} from "firebase-admin/firestore";
import { z } from "zod";
import { collectionName, firestore } from "../../firebase/firestore.js";

const TimestampField = z.instanceof(Timestamp);

const ChatMetaSchema = z.object({
  lastSeq: z.number().int().nonnegative(),
  lastMessageId: z.string().nullable(),
  lastMessageAt: TimestampField.nullable(),
});

const MessageSchema = z.object({
  chatId: z.string(),
  senderId: z.string(),
  text: z.string(),
  seq: z.number().int().positive(),
  createdAt: TimestampField,
  editedAt: TimestampField.nullable(),
  deletedAt: TimestampField.nullable(),
  readBy: z.record(z.string(), TimestampField),
});

const MemberStateSchema = z.object({
  userId: z.string(),
  lastSeenMessageId: z.string(),
  lastSeenSeq: z.number().int().positive(),
  lastSeenAt: TimestampField,
  updatedAt: TimestampField,
});

export type ChatMetaDoc = z.infer<typeof ChatMetaSchema>;
export type MessageDoc = z.infer<typeof MessageSchema>;
export type MemberStateDoc = z.infer<typeof MemberStateSchema>;

function converter<T extends DocumentData>(schema: z.ZodType<T>): FirestoreDataConverter<T> {
  return {
    toFirestore: (value) => value,
    fromFirestore: (snapshot: QueryDocumentSnapshot) => schema.parse(snapshot.data()),
  };
}

const chatMetaConverter = converter(ChatMetaSchema);
const messageConverter = converter(MessageSchema);
const memberStateConverter = converter(MemberStateSchema);

export function chatMetaRef(chatId: string): DocumentReference<ChatMetaDoc> {
  return firestore().collection(collectionName("chats")).doc(chatId).withConverter(chatMetaConverter);
}

export function messagesRef(chatId: string): CollectionReference<MessageDoc> {
  return firestore()
    .collection(collectionName("chats"))
    .doc(chatId)
    .collection("messages")
    .withConverter(messageConverter);
}

export function memberStateRef(chatId: string, userId: string): DocumentReference<MemberStateDoc> {
  return firestore()
    .collection(collectionName("chats"))
    .doc(chatId)
    .collection("members")
    .doc(userId)
    .withConverter(memberStateConverter);
}

export function membersRef(chatId: string): CollectionReference<MemberStateDoc> {
  return firestore()
    .collection(collectionName("chats"))
    .doc(chatId)
    .collection("members")
    .withConverter(memberStateConverter);
}

export function rawChatRef(chatId: string): DocumentReference {
  return firestore().collection(collectionName("chats")).doc(chatId);
}
