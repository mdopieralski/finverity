import { Inject, Injectable, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { type Consumer, Kafka, logLevel } from 'kafkajs';

import { CONFIG, type Config } from '../config/config.js';
import { log } from '../logging/logger.js';
import { TreasuryHandler } from './treasury.handler.js';

/**
 * Consumes treasury.capacity.v1 with auto-commit OFF. Per message: handle (one DB transaction), then
 * commit offset + 1. Never the other way round. If handle throws (transient), the offset stays and
 * kafkajs retries the message after a back-off.
 */
@Injectable()
export class TreasuryConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private consumer: Consumer | undefined;

  constructor(
    @Inject(CONFIG) private readonly config: Config,
    @Inject(TreasuryHandler) private readonly handler: TreasuryHandler
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.kafkaEnabled) {
      return;
    }
    const kafka = new Kafka({
      clientId: 'program-capacity',
      brokers: this.config.kafkaBrokers,
      logLevel: logLevel.WARN,
      logCreator: () => (entry) =>
        log('warn', 'kafka', { namespace: entry.namespace, message: entry.log.message }),
    });
    const admin = kafka.admin();
    await admin.connect();
    await admin.createTopics({
      topics: [{ topic: this.config.kafkaTopic, numPartitions: 3 }],
      waitForLeaders: true,
    });
    await admin.disconnect();

    const consumer = kafka.consumer({ groupId: this.config.kafkaGroupId });
    this.consumer = consumer;
    await consumer.connect();
    await consumer.subscribe({ topic: this.config.kafkaTopic, fromBeginning: true });
    await consumer.run({
      autoCommit: false,
      eachMessage: async ({ topic, partition, message }) => {
        await this.handler.handle(message.value, { topic, partition, offset: message.offset });
        await consumer.commitOffsets([
          { topic, partition, offset: (BigInt(message.offset) + 1n).toString() },
        ]);
      },
    });
    log('info', 'treasury consumer started', {
      topic: this.config.kafkaTopic,
      groupId: this.config.kafkaGroupId,
    });
  }

  async onApplicationShutdown(): Promise<void> {
    // disconnect() lets the in-flight eachMessage (and its offset commit) finish first.
    await this.consumer?.disconnect();
  }
}
