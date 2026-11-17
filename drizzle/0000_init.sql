CREATE TYPE "public"."chat_type" AS ENUM('direct', 'group');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('owner', 'admin', 'member');--> statement-breakpoint
CREATE TABLE "chat_members" (
	"chat_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "member_role" DEFAULT 'member' NOT NULL,
	"joined_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_members_pk" PRIMARY KEY("chat_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "chats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "chat_type" NOT NULL,
	"name" text,
	"direct_key" text,
	"created_by" uuid,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chats_direct_key_uq" UNIQUE("direct_key"),
	CONSTRAINT "chats_type_shape_ck" CHECK (("chats"."type" = 'direct' and "chats"."direct_key" is not null and "chats"."name" is null)
        or ("chats"."type" = 'group' and "chats"."direct_key" is null and "chats"."name" is not null))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_members" ADD CONSTRAINT "chat_members_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_members" ADD CONSTRAINT "chat_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chats" ADD CONSTRAINT "chats_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_members_user_idx" ON "chat_members" USING btree ("user_id");