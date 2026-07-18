import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { apiError } from "@chatterscope/contracts";
import { verifyEventSubSignature } from "./signature.js";
import { chatMessageEventSchema, normalizeChatMessageEvent } from "./normalize.js";
import type { ServerDeps } from "../server.js";

const webhookBodySchema = z.object({
  challenge: z.string().optional(),
  subscription: z.object({
    id: z.string(),
    type: z.string(),
    status: z.string(),
  }),
  event: z.unknown().optional(),
});

export function registerEventSubRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const { env, ingestor } = deps;

  // Signature verification needs the exact raw bytes Twitch signed.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, payload, done) => {
    (request as { rawBody?: string }).rawBody = payload as string;
    try {
      done(null, payload === "" ? {} : JSON.parse(payload as string));
    } catch (error) {
      done(error as Error);
    }
  });

  app.post("/v1/eventsub/webhook", async (request, reply) => {
    if (!env.TWITCH_EVENTSUB_SECRET || !ingestor) {
      return reply
        .status(503)
        .send(apiError("EVENTSUB_NOT_CONFIGURED", "EventSub secret is not configured."));
    }

    const rawBody = (request as { rawBody?: string }).rawBody ?? "";
    const check = verifyEventSubSignature(
      {
        messageId: request.headers["twitch-eventsub-message-id"] as string | undefined,
        timestamp: request.headers["twitch-eventsub-message-timestamp"] as string | undefined,
        signature: request.headers["twitch-eventsub-message-signature"] as string | undefined,
      },
      rawBody,
      env.TWITCH_EVENTSUB_SECRET,
    );
    if (!check.valid) {
      request.log.warn({ reason: check.reason }, "eventsub signature rejected");
      return reply.status(403).send(apiError("SIGNATURE_INVALID", check.reason));
    }

    const parsed = webhookBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send(apiError("BODY_INVALID", "Unrecognized EventSub payload."));
    }

    const messageType = request.headers["twitch-eventsub-message-type"];
    if (messageType === "webhook_callback_verification") {
      return reply.type("text/plain").send(parsed.data.challenge ?? "");
    }
    if (messageType === "revocation") {
      request.log.warn(
        { subscriptionId: parsed.data.subscription.id, status: parsed.data.subscription.status },
        "eventsub subscription revoked",
      );
      return reply.send({ ok: true });
    }
    if (messageType !== "notification") {
      return reply.status(400).send(apiError("UNKNOWN_MESSAGE_TYPE", String(messageType)));
    }

    if (parsed.data.subscription.type === "channel.chat.message") {
      const event = chatMessageEventSchema.safeParse(parsed.data.event);
      if (!event.success) {
        request.log.error({ issues: event.error.issues }, "chat message event failed validation");
        return reply.status(400).send(apiError("EVENT_INVALID", "Malformed chat message event."));
      }
      const timestamp = request.headers["twitch-eventsub-message-timestamp"] as string;
      const result = await ingestor.ingest(
        normalizeChatMessageEvent(event.data, timestamp, parsed.data.event),
      );
      request.log.info(
        { messageId: event.data.message_id, result: result.status },
        "chat message processed",
      );
    } else {
      request.log.info({ type: parsed.data.subscription.type }, "ignoring eventsub type");
    }
    return reply.send({ ok: true });
  });
}
