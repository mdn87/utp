import { createHash } from "node:crypto";
import type { DeliveryAdapter, ReviewNotification } from "../core/delivery-adapter.js";
import { Engine, type ReviewDelivery } from "../core/engine.js";
import { writeNoticeDigest } from "../core/report-inbox.js";
import type { Service } from "./service.js";

export interface NotificationOptions {
  send: NonNullable<DeliveryAdapter["sendReview"]>;
  retryMs?: number;
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function notification(project: string, delivery: ReviewDelivery): ReviewNotification {
  const dedupe_key = `utp:${project}:${delivery.review}`;
  return {
    schema: "utp-review-delivery/v1",
    type: delivery.action === "request" ? "review.ready" : "review.resolved",
    dedupe_key,
    event_id: `evt_${hash(dedupe_key + ":" + delivery.action)}`,
    review_id: delivery.review,
    questions: delivery.questions,
  };
}

export class ReviewDeliveries {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;

  constructor(private readonly service: Service, private readonly log: (message: string) => void,
    private readonly options?: NotificationOptions, private readonly inboxDir?: string,
    private readonly formatInboxItem?: DeliveryAdapter["formatInboxItem"]) {}

  start(): void {
    this.timer = setInterval(() => this.kick(), this.options?.retryMs ?? 10_000);
    this.kick();
  }

  kick(): void {
    if (!this.timer || this.running) return;
    this.running = this.deliver().catch(() => this.log("Could not check UTP review deliveries."))
      .finally(() => { this.running = undefined; });
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  private async deliver(): Promise<void> {
    for (const { id } of this.service.projects()) {
      const engine = this.service.engine(id);
      if (!(engine instanceof Engine)) continue;
      if (this.inboxDir) {
        for (const digest of engine.noticeDigests()) {
          try {
            writeNoticeDigest(this.inboxDir, id, digest, this.formatInboxItem);
            engine.recordDigest(digest);
          } catch {
            this.log("Could not publish a UTP notice to the morning report inbox. UTP will retry.");
          }
        }
      }
      if (!this.options) continue;
      for (const item of engine.reviewDeliveries()) {
        if (!this.timer) return;
        const event = notification(id, item);
        try {
          const ack = await this.options.send(event, AbortSignal.timeout(5_000));
          if (ack?.ok !== true || ack.event_id !== event.event_id) throw new Error("event not accepted");
          engine.recordDelivery(item);
        } catch {
          this.log("The notification provider did not confirm a review event. UTP will retry the same event.");
        }
      }
    }
  }
}
