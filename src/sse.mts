// sse.ts — SSE hub backed by UtteranceLog pub/sub.
//
// Each subscriber is a Meme: {subject: subscriberId, predicate: "topic", object: topicName}.
// publish() stores event Memes and fans out to matching subscribers.
// The UtteranceLog gives us an append-only audit log of all events published.

import { witness, UtteranceLog } from "./internal/witness.mjs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sse, type SseWriter } from "./http.mjs";
import {
  writeSseComment,
  writeSseEvent,
  type TopicEvent,
} from "@red-cup-engineering/computing-with-http/app";
export {
  createProjectedEventHub,
  writeSseComment,
  writeSseEvent,
  type SseSink,
  type TopicEvent,
} from "@red-cup-engineering/computing-with-http/app";

export type SseHub = {
  subscribe(req: IncomingMessage, res: ServerResponse, opts?: { topics?: readonly string[] }): SseWriter;
  publish(event: string, data: unknown, opts?: { topic?: string; id?: string }): void;
  subscribers: number;
  size: number;
  close(): void;
};

export function createSseHub(opts: { heartbeatMs?: number } = {}): SseHub {
  const store = new UtteranceLog();
  const heartbeatMs = opts.heartbeatMs ?? 30_000;

  type Sub = { writer: SseWriter; topics: Set<string> | null };
  const subs = new Map<string, Sub>();
  let subCounter = 0;
  let eventCounter = 0;
  let heartbeat: ReturnType<typeof setInterval> | undefined;

  function stopHeartbeat(): void {
    if (!heartbeat) return;
    clearInterval(heartbeat);
    heartbeat = undefined;
  }

  function startHeartbeat(): void {
    if (heartbeat || heartbeatMs <= 0) return;
    heartbeat = setInterval(() => {
      const dead: string[] = [];
      for (const [id, { writer }] of subs) {
        try { writer.comment("heartbeat"); }
        catch { dead.push(id); }
      }
      for (const id of dead) reap(id);
    }, heartbeatMs);
    heartbeat.unref?.();
  }

  function reap(id: string): void {
    if (!subs.delete(id)) return;
    witness(store, { subject: id, predicate: "status", object: "closed" }, [false, true]); // sub id is the counter ordinal
    if (!subs.size) stopHeartbeat();
  }

  return {
    get subscribers() { return subs.size; },
    get size() { return subs.size; },

    subscribe(req, res, subOpts = {}): SseWriter {
      const id = `sub-${++subCounter}`;
      const topics = subOpts.topics?.length ? new Set(subOpts.topics) : null;

      witness(store, { subject: id, predicate: "status", object: "open" }, [true, false]);
      if (topics) {
        for (const topic of topics) {
          witness(store, { subject: id, predicate: "topic", object: topic }, [true, false]);
        }
      }

      const writer = sse(req, res, () => reap(id));
      subs.set(id, { writer, topics });
      startHeartbeat();
      return writer;
    },

    publish(event, data, pubOpts = {}): void {
      const { topic, id } = pubOpts;
      const eventId = `event-${++eventCounter}`; // ordinal identity; wall-clock identity collided same-ms publishes
      witness(store, { subject: eventId, predicate: "event", object: event }, [true, false]);
      if (topic) {
        witness(store, { subject: eventId, predicate: "topic", object: topic }, [true, false]);
      }

      const dead: string[] = [];
      for (const [subId, sub] of subs) {
        if (sub.topics && (topic == null || !sub.topics.has(topic))) continue;
        try { sub.writer.send(event, data, id); }
        catch { dead.push(subId); }
      }
      for (const d of dead) reap(d);
    },

    close(): void {
      for (const id of [...subs.keys()]) {
        const sub = subs.get(id);
        try { sub?.writer.close(); } catch {}
        reap(id);
      }
      stopHeartbeat();
    },
  };
}
