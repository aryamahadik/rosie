// T-1128 spike: a Durable Object, a queue consumer and a cron handler that exist only to be tested. Nothing here is
// product code: runtime/src/index.ts does not import this file, and nothing imports it except the spike's tests.
import { DurableObject, exports } from "cloudflare:workers";

import * as main from "../../index";

/** What the spike actor keeps in storage under one key. */
export interface Counter {
  alarms: number;
  lastAlarmRetryCount: number | undefined;
}

/** A stand-in for the handle actor: KV-style storage, SQL storage, and an alarm that counts its own runs. */
export class SpikeActor extends DurableObject {
  /** In-memory state: lost when the instance is evicted, unlike storage. */
  memoryHits = 0;

  async write(key: string, value: string): Promise<void> {
    this.memoryHits += 1;
    await this.ctx.storage.put(key, value);
  }

  async read(key: string): Promise<string | undefined> {
    return this.ctx.storage.get<string>(key);
  }

  async keys(): Promise<string[]> {
    return [...(await this.ctx.storage.list()).keys()];
  }

  /** SQLite-backed storage (wrangler.jsonc uses new_sqlite_classes): the SQL API is available. */
  sqlRoundTrip(value: string): string[] {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS notes (body TEXT NOT NULL)");
    this.ctx.storage.sql.exec("INSERT INTO notes (body) VALUES (?)", value);
    return this.ctx.storage.sql
      .exec<{ body: string }>("SELECT body FROM notes")
      .toArray()
      .map((row) => row.body);
  }

  /** Sets the one actor alarm `ms` from now (the real clock is not read again until the alarm is run). */
  async scheduleIn(ms: number): Promise<number> {
    const at = Date.now() + ms;
    await this.ctx.storage.setAlarm(at);
    return at;
  }

  async alarmAt(): Promise<number | null> {
    return this.ctx.storage.getAlarm();
  }

  async counter(): Promise<Counter> {
    return (await this.ctx.storage.get<Counter>("counter")) ?? { alarms: 0, lastAlarmRetryCount: undefined };
  }

  override async alarm(info?: AlarmInvocationInfo): Promise<void> {
    const before = await this.counter();
    await this.ctx.storage.put<Counter>("counter", {
      alarms: before.alarms + 1,
      lastAlarmRetryCount: info?.retryCount,
    });
  }

  hits(): number {
    return this.memoryHits;
  }
}

type SpikeNamespace = DurableObjectNamespace<SpikeActor>;

/**
 * The Workers test plugin builds a Durable Object by looking its class up in the exports of the one `main` module
 * (runtime/src/index.ts), and index.ts exports no HandleActor yet (T-244). This publishes SpikeActor under that
 * name for one test file and returns the function that puts the module back as it was.
 */
export function publishSpikeActorAsHandleActor(): () => void {
  const before = Object.getOwnPropertyDescriptor(main, "HandleActor");
  Object.defineProperty(main, "HandleActor", { value: SpikeActor, configurable: true, enumerable: true });
  return () => {
    if (before === undefined) {
      Reflect.deleteProperty(main, "HandleActor");
    } else {
      Object.defineProperty(main, "HandleActor", before);
    }
  };
}

/** The HandleActor namespace as the test plugin offers it: through `exports`, since env.staging has no binding yet. */
export function actors(): SpikeNamespace {
  return (exports as unknown as { HandleActor: SpikeNamespace }).HandleActor;
}

/** A message body of the spike's queue. */
export interface SpikeMessage {
  handle: string;
  /** True: the consumer asks for a retry instead of an acknowledgement. */
  fail?: boolean;
}

/** A queue consumer: writes each message into its handle's actor and acknowledges, or retries when `fail` is set. */
export const spikeQueueConsumer = {
  async queue(batch: MessageBatch<SpikeMessage>): Promise<void> {
    for (const message of batch.messages) {
      if (message.body.fail === true) {
        message.retry({ delaySeconds: 30 });
        continue;
      }
      const actor = actors().get(actors().idFromName(message.body.handle));
      await actor.write(`queued:${message.id}`, batch.queue);
      message.ack();
    }
  },
};

/** A cron handler: the minute sweep finds an actor that is due and sets its alarm to now. */
export const spikeCronHandler = {
  scheduled(controller: ScheduledController, _env: Cloudflare.Env, ctx: ExecutionContext): void {
    const actor = actors().get(actors().idFromName("due-handle"));
    ctx.waitUntil(
      actor
        .scheduleIn(0)
        .then(() => actor.write("swept-by", `${controller.cron}@${String(controller.scheduledTime)}`)),
    );
  },
};
