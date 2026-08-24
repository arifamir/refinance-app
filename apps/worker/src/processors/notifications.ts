/**
 * Notifications — best-effort.
 *
 * The one queue whose failure must never block the flow. An SMS provider
 * outage cannot be allowed to stop a loan being disbursed, so this queue has
 * its own shorter retry policy and nothing downstream depends on it.
 */

import type { Job } from "bullmq";
import type { NotificationJob } from "@refi/domain";
import { getAdapters } from "@refi/adapters";
import { log } from "../connection.js";

export async function processNotification(job: Job<NotificationJob>): Promise<void> {
  const { channel, template, to, data, correlationId } = job.data;
  const { notifier } = getAdapters();

  await notifier.send({ channel, template, to, data });
  log("notifications", correlationId, `sent ${template} via ${channel}`);
}
