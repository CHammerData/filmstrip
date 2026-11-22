-- Per-user list policy and list approval (DESIGN.md §9a). The column defaults are the restrictive
-- ones, so a user created by any path that doesn't set a policy can't add lists unreviewed. Users
-- that already exist keep what they could already do (auto, any profile, no cap), and existing
-- lists stay approved.
ALTER TABLE "Settings" ADD COLUMN "newUserListAccess" TEXT NOT NULL DEFAULT 'approval';
ALTER TABLE "Settings" ADD COLUMN "newUserMaxListSize" INTEGER DEFAULT 50;

ALTER TABLE "User" ADD COLUMN "listAccess" TEXT NOT NULL DEFAULT 'approval';
ALTER TABLE "User" ADD COLUMN "qualityProfiles" TEXT;
ALTER TABLE "User" ADD COLUMN "maxListSize" INTEGER;
UPDATE "User" SET "listAccess" = 'auto', "qualityProfiles" = '*';

ALTER TABLE "List" ADD COLUMN "approval" TEXT NOT NULL DEFAULT 'approved';
