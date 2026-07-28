import type { FastifyPluginAsync } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Static assets (02-architecture §1): the founder's landing page at `/`.
 * The dashboard SPA bundle is wired under `/app` in M4/M7. In production the
 * Dockerfile places the SPA at dist/public; the landing port is finalized at M7.
 */
export const staticPlugin: FastifyPluginAsync = async (fastify) => {
  const landingDir = path.resolve(process.cwd(), 'apps/landing');
  if (!existsSync(landingDir)) {
    fastify.log.warn({ landingDir }, 'landing assets not found; static plugin idle');
    return;
  }
  await fastify.register(fastifyStatic, { root: landingDir, prefix: '/' });
};
