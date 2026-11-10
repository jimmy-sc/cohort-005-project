import { and, asc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { Db } from "~/db";
import { formatPrice } from "~/lib/utils";
import {
  courseRatings,
  courses,
  enrollments,
  purchases,
  refunds,
  users,
  RefundStatus,
} from "~/db/schema";

// ─── Refund Request decisions ───
// Approving and declining Refund Requests, and the list admins decide from.
// Takes the database as its first parameter so tests can pass an in-memory one.
// See docs/adr/0001–0003 for why a refund keeps progress, why a decision is
// final, and why money states don't belong in RefundStatus.

export type DecisionResult =
  | { outcome: "decided" }
  | { outcome: "already-decided" }
  | { outcome: "not-found" };

const deciders = alias(users, "deciders");

function selectRefundRequests(db: Db) {
  return db
    .select({
      id: refunds.id,
      status: refunds.status,
      reason: refunds.reason,
      requestedAt: refunds.requestedAt,
      resolvedAt: refunds.resolvedAt,
      amountRefunded: refunds.amountRefunded,
      declineReason: refunds.decisionNote,
      learnerName: users.name,
      learnerEmail: users.email,
      courseTitle: courses.title,
      courseSlug: courses.slug,
      amountPaid: purchases.amountPaid,
      resolvedByName: deciders.name,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .leftJoin(deciders, eq(refunds.resolvedByUserId, deciders.id));
}

/** Open Refund Requests oldest first, then decided ones newest decision first. */
export function listRefundRequests(db: Db) {
  return selectRefundRequests(db)
    .orderBy(
      sql`case when ${refunds.status} = ${RefundStatus.Open} then 0 else 1 end`,
      sql`case when ${refunds.status} = ${RefundStatus.Open} then ${refunds.requestedAt} end asc`,
      sql`${refunds.resolvedAt} desc`,
      asc(refunds.id)
    )
    .all();
}

export function findRefundRequest(db: Db, refundRequestId: number) {
  return selectRefundRequests(db).where(eq(refunds.id, refundRequestId)).get();
}

/**
 * Approves an Open Refund Request for the full amount paid, and ends the
 * learner's access to the course. Their rating goes too, so it stops counting
 * toward the course average. Lesson progress, quiz attempts, watch events and
 * comments stay (ADR 0001). The decision is final (ADR 0002).
 */
export function approveRefundRequest(
  db: Db,
  refundRequestId: number,
  adminUserId: number
): DecisionResult {
  const request = db
    .select({
      amountPaid: purchases.amountPaid,
      learnerId: purchases.userId,
      courseId: purchases.courseId,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .where(eq(refunds.id, refundRequestId))
    .get();

  if (!request) return { outcome: "not-found" };

  // Conditioned on Open, so a second admin deciding the same request changes
  // nothing, even if the learner has since bought the course again.
  return db.transaction((tx): DecisionResult => {
    const { changes } = tx
      .update(refunds)
      .set({
        status: RefundStatus.Approved,
        amountRefunded: request.amountPaid,
        resolvedAt: new Date().toISOString(),
        resolvedByUserId: adminUserId,
      })
      .where(
        and(
          eq(refunds.id, refundRequestId),
          eq(refunds.status, RefundStatus.Open)
        )
      )
      .run();

    if (changes === 0) return { outcome: "already-decided" };

    tx.delete(enrollments)
      .where(
        and(
          eq(enrollments.userId, request.learnerId),
          eq(enrollments.courseId, request.courseId)
        )
      )
      .run();

    tx.delete(courseRatings)
      .where(
        and(
          eq(courseRatings.userId, request.learnerId),
          eq(courseRatings.courseId, request.courseId)
        )
      )
      .run();

    return { outcome: "decided" };
  });
}

/**
 * Declines an Open Refund Request with a Decline Reason for the learner.
 * Their access stays. The decision is final (ADR 0002); the learner may raise
 * a new Refund Request instead.
 */
export function declineRefundRequest(
  db: Db,
  refundRequestId: number,
  adminUserId: number,
  declineReason: string
): DecisionResult {
  const { changes } = db
    .update(refunds)
    .set({
      status: RefundStatus.Declined,
      decisionNote: declineReason,
      resolvedAt: new Date().toISOString(),
      resolvedByUserId: adminUserId,
    })
    .where(
      and(eq(refunds.id, refundRequestId), eq(refunds.status, RefundStatus.Open))
    )
    .run();

  if (changes > 0) return { outcome: "decided" };

  const exists = db
    .select({ id: refunds.id })
    .from(refunds)
    .where(eq(refunds.id, refundRequestId))
    .get();

  return exists ? { outcome: "already-decided" } : { outcome: "not-found" };
}

// ─── Decision emails ───
// No mail transport is wired up yet, so the routes write these to the server
// log, like the refund request confirmation.

type EmailRecipient = {
  learnerName: string;
  learnerEmail: string;
  courseTitle: string;
};

export function buildApprovalEmail(
  input: EmailRecipient & { amountRefunded: number }
) {
  return {
    to: input.learnerEmail,
    subject: `Refund approved — ${input.courseTitle}`,
    body: [
      `Hi ${input.learnerName},`,
      "",
      `We have approved your refund request for "${input.courseTitle}".`,
      `We are refunding ${formatPrice(input.amountRefunded)}, the full amount you paid. You no longer have access to the course.`,
      "",
      "Your progress is saved. If you buy the course again, you'll pick up where you left off.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}

export function buildDeclineEmail(
  input: EmailRecipient & { declineReason: string }
) {
  return {
    to: input.learnerEmail,
    subject: `Refund declined — ${input.courseTitle}`,
    body: [
      `Hi ${input.learnerName},`,
      "",
      `We have declined your refund request for "${input.courseTitle}". Here is why:`,
      "",
      input.declineReason,
      "",
      "If you still qualify, you can raise a new refund request from the course page.",
      "",
      "— The Cadence team",
    ].join("\n"),
  };
}
