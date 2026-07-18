import type { FastifyReply, FastifyRequest } from "fastify";
import { apiError } from "@chatterscope/contracts";
import type { Session } from "../auth/session.js";
import type { ServerDeps } from "../server.js";

export const SESSION_COOKIE = "cs_session";

declare module "fastify" {
  interface FastifyRequest {
    session?: Session;
  }
}

/**
 * preHandler that requires a valid session cookie. Also applies a same-origin
 * check to mutating requests as CSRF protection (session cookie is SameSite=Lax,
 * this adds explicit Origin validation for POST/PATCH/DELETE).
 */
export function requireSession(deps: ServerDeps) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const sessionId = request.cookies[SESSION_COOKIE];
    const session = sessionId ? await deps.sessions.get(sessionId) : null;
    if (!session) {
      await reply.status(401).send(apiError("UNAUTHENTICATED", "Sign in with Twitch first."));
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      const origin = request.headers.origin;
      const allowed = [deps.env.WEB_ORIGIN, deps.env.API_ORIGIN];
      if (origin && !allowed.includes(origin)) {
        await reply.status(403).send(apiError("ORIGIN_FORBIDDEN", "Cross-origin request denied."));
        return;
      }
    }
    request.session = session;
  };
}
