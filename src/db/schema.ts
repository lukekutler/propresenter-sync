
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';

export const plans = sqliteTable('plans', {
  id: text('id').primaryKey(),
  sourceId: text('source_id'),
  date: text('date'),
  title: text('title'),
  raw: text('raw_json'),
  status: text('status')
});

export const items = sqliteTable('items', {
  id: text('id').primaryKey(),
  planId: text('plan_id'),
  kind: text('kind'),
  title: text('title'),
  orderIndex: integer('order_index')
});

export const logs = sqliteTable('logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  ts: integer('ts'),
  level: text('level'),
  message: text('message'),
});
