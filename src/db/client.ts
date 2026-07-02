import { PrismaClient } from '@prisma/client';

// Single shared PrismaClient for the process. Re-instantiating PrismaClient per
// import exhausts the SQLite connection/file handles, so we memoize on globalThis
// (also avoids duplicate clients under ts-node/nodemon hot-reload in dev).
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.LOG_LEVEL === 'debug' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

export default prisma;
