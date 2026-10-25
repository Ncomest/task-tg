CREATE TYPE "TeamRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "TeamMembership" (
    "teamId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "TeamRole" NOT NULL DEFAULT 'MEMBER',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TeamMembership_pkey" PRIMARY KEY ("teamId", "userId"),
    CONSTRAINT "TeamMembership_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TeamMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "TeamMembership_userId_idx" ON "TeamMembership"("userId");
CREATE UNIQUE INDEX "TeamMembership_one_owner" ON "TeamMembership"("teamId") WHERE "role" = 'OWNER';
CREATE TABLE "TeamInvite" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "creatorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "usedAt" TIMESTAMP(3),
    "usedById" TEXT,
    CONSTRAINT "TeamInvite_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TeamInvite_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TeamInvite_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "TeamInvite_usedById_fkey" FOREIGN KEY ("usedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TeamInvite_tokenHash_key" ON "TeamInvite"("tokenHash");
CREATE INDEX "TeamInvite_teamId_createdAt_idx" ON "TeamInvite"("teamId", "createdAt");
CREATE INDEX "TeamInvite_creatorId_idx" ON "TeamInvite"("creatorId");
CREATE INDEX "TeamInvite_expiresAt_idx" ON "TeamInvite"("expiresAt");
