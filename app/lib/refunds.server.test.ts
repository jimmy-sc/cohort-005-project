import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "~/db/test-db.server";
import type { Db } from "~/db";
import { and, eq } from "drizzle-orm";
import {
  categories,
  comments,
  courseRatings,
  courses,
  enrollments,
  lessonProgress,
  lessons,
  modules,
  purchases,
  quizAttempts,
  quizzes,
  videoWatchEvents,
  LessonProgressStatus,
  refunds,
  users,
  CourseStatus,
  RefundStatus,
  UserRole,
} from "~/db/schema";
import {
  approveRefundRequest,
  buildApprovalEmail,
  buildDeclineEmail,
  declineRefundRequest,
  listRefundRequests,
} from "./refunds.server";

let db: Db;
let adminId: number;
let learnerId: number;
let courseId: number;

beforeEach(() => {
  db = createTestDb();

  adminId = db
    .insert(users)
    .values({ name: "Ada Admin", email: "ada@example.com", role: UserRole.Admin })
    .returning()
    .get().id;
  const instructorId = db
    .insert(users)
    .values({ name: "Ivy Instructor", email: "ivy@example.com", role: UserRole.Instructor })
    .returning()
    .get().id;
  learnerId = db
    .insert(users)
    .values({ name: "Liam Learner", email: "liam@example.com", role: UserRole.Student })
    .returning()
    .get().id;
  const categoryId = db
    .insert(categories)
    .values({ name: "Programming", slug: "programming" })
    .returning()
    .get().id;
  courseId = db
    .insert(courses)
    .values({
      title: "Introduction to TypeScript",
      slug: "intro-to-typescript",
      description: "Types for JavaScript developers.",
      salesCopy: "Learn TypeScript.",
      instructorId,
      categoryId,
      status: CourseStatus.Published,
      price: 7900,
    })
    .returning()
    .get().id;
});

function buyCourse(amountPaid = 7900) {
  return db
    .insert(purchases)
    .values({ userId: learnerId, courseId, amountPaid })
    .returning()
    .get();
}

function raiseRefundRequest(
  purchaseId: number,
  requestedAt: string,
  status = RefundStatus.Open
) {
  return db
    .insert(refunds)
    .values({ purchaseId, reason: "The course was not what I expected.", requestedAt, status })
    .returning()
    .get();
}

describe("listRefundRequests", () => {
  it("lists Open Refund Requests oldest first, then decided ones", () => {
    const purchase = buyCourse();
    const newerOpen = raiseRefundRequest(purchase.id, "2026-11-05T10:00:00.000Z");
    const declined = raiseRefundRequest(
      purchase.id,
      "2026-11-01T10:00:00.000Z",
      RefundStatus.Declined
    );
    const olderOpen = raiseRefundRequest(purchase.id, "2026-11-03T10:00:00.000Z");

    const ids = listRefundRequests(db).map((request) => request.id);

    expect(ids).toEqual([olderOpen.id, newerOpen.id, declined.id]);
  });

  it("shows who asked, for which course, how much they paid and why", () => {
    const purchase = buyCourse(7900);
    raiseRefundRequest(purchase.id, "2026-11-03T10:00:00.000Z");

    const [request] = listRefundRequests(db);

    expect(request).toMatchObject({
      learnerName: "Liam Learner",
      learnerEmail: "liam@example.com",
      courseTitle: "Introduction to TypeScript",
      amountPaid: 7900,
      reason: "The course was not what I expected.",
      requestedAt: "2026-11-03T10:00:00.000Z",
      status: RefundStatus.Open,
    });
  });
});

describe("approveRefundRequest", () => {
  it("approves the request for the full amount paid and records who decided", () => {
    const purchase = buyCourse(7900);
    const request = raiseRefundRequest(purchase.id, "2026-11-03T10:00:00.000Z");

    const result = approveRefundRequest(db, request.id, adminId);

    expect(result).toEqual({ outcome: "decided" });
    const [approved] = listRefundRequests(db);
    expect(approved).toMatchObject({
      status: RefundStatus.Approved,
      amountRefunded: 7900,
      resolvedByName: "Ada Admin",
    });
    expect(approved.resolvedAt).not.toBeNull();
  });
});

describe("approveRefundRequest and the learner's course", () => {
  let lessonId: number;

  beforeEach(() => {
    const moduleId = db
      .insert(modules)
      .values({ courseId, title: "Basics", position: 1 })
      .returning()
      .get().id;
    lessonId = db
      .insert(lessons)
      .values({ moduleId, title: "Why types", position: 1 })
      .returning()
      .get().id;
    const quizId = db
      .insert(quizzes)
      .values({ lessonId, title: "Types quiz", passingScore: 0.7 })
      .returning()
      .get().id;

    db.insert(enrollments).values({ userId: learnerId, courseId }).run();
    db.insert(courseRatings).values({ userId: learnerId, courseId, rating: 2 }).run();
    db.insert(lessonProgress)
      .values({ userId: learnerId, lessonId, status: LessonProgressStatus.Completed })
      .run();
    db.insert(quizAttempts)
      .values({ userId: learnerId, quizId, score: 0.8, passed: true })
      .run();
    db.insert(videoWatchEvents)
      .values({ userId: learnerId, lessonId, eventType: "pause", positionSeconds: 600 })
      .run();
    db.insert(comments)
      .values({ userId: learnerId, lessonId, body: "Great first lesson." })
      .run();
  });

  function approve() {
    const purchase = buyCourse();
    const request = raiseRefundRequest(purchase.id, "2026-11-03T10:00:00.000Z");
    approveRefundRequest(db, request.id, adminId);
  }

  it("ends the learner's access to the course", () => {
    approve();

    const enrollment = db
      .select()
      .from(enrollments)
      .where(and(eq(enrollments.userId, learnerId), eq(enrollments.courseId, courseId)))
      .get();
    expect(enrollment).toBeUndefined();
  });

  it("removes the learner's rating so it no longer counts toward the course average", () => {
    approve();

    const rating = db
      .select()
      .from(courseRatings)
      .where(and(eq(courseRatings.userId, learnerId), eq(courseRatings.courseId, courseId)))
      .get();
    expect(rating).toBeUndefined();
  });

  it("keeps lesson progress, quiz attempts, watch events and comments", () => {
    approve();

    expect(db.select().from(lessonProgress).where(eq(lessonProgress.userId, learnerId)).all()).toHaveLength(1);
    expect(db.select().from(quizAttempts).where(eq(quizAttempts.userId, learnerId)).all()).toHaveLength(1);
    expect(db.select().from(videoWatchEvents).where(eq(videoWatchEvents.userId, learnerId)).all()).toHaveLength(1);
    expect(db.select().from(comments).where(eq(comments.userId, learnerId)).all()).toHaveLength(1);
  });
});

describe("deciding a Refund Request that is not Open", () => {
  it("reports an already-decided request and leaves the learner's access alone", () => {
    const purchase = buyCourse();
    const declined = raiseRefundRequest(
      purchase.id,
      "2026-11-03T10:00:00.000Z",
      RefundStatus.Declined
    );
    db.insert(enrollments).values({ userId: learnerId, courseId }).run();

    const result = approveRefundRequest(db, declined.id, adminId);

    expect(result).toEqual({ outcome: "already-decided" });
    expect(listRefundRequests(db)[0].status).toBe(RefundStatus.Declined);
    expect(
      db.select().from(enrollments).where(eq(enrollments.userId, learnerId)).all()
    ).toHaveLength(1);
  });

  it("reports a Refund Request that doesn't exist", () => {
    expect(approveRefundRequest(db, 999, adminId)).toEqual({ outcome: "not-found" });
  });
});

describe("declineRefundRequest", () => {
  const declineReason = "You have already finished most of the course.";

  it("declines the request with a Decline Reason and records who decided", () => {
    const purchase = buyCourse();
    const request = raiseRefundRequest(purchase.id, "2026-11-03T10:00:00.000Z");

    const result = declineRefundRequest(db, request.id, adminId, declineReason);

    expect(result).toEqual({ outcome: "decided" });
    const [declined] = listRefundRequests(db);
    expect(declined).toMatchObject({
      status: RefundStatus.Declined,
      declineReason,
      amountRefunded: null,
      resolvedByName: "Ada Admin",
    });
    expect(declined.resolvedAt).not.toBeNull();
  });

  it("keeps the learner's access to the course", () => {
    const purchase = buyCourse();
    const request = raiseRefundRequest(purchase.id, "2026-11-03T10:00:00.000Z");
    db.insert(enrollments).values({ userId: learnerId, courseId }).run();

    declineRefundRequest(db, request.id, adminId, declineReason);

    expect(
      db.select().from(enrollments).where(eq(enrollments.userId, learnerId)).all()
    ).toHaveLength(1);
  });

  it("reports an already-decided request without overwriting the decision", () => {
    const purchase = buyCourse();
    const request = raiseRefundRequest(purchase.id, "2026-11-03T10:00:00.000Z");
    approveRefundRequest(db, request.id, adminId);

    const result = declineRefundRequest(db, request.id, adminId, declineReason);

    expect(result).toEqual({ outcome: "already-decided" });
    expect(listRefundRequests(db)[0]).toMatchObject({
      status: RefundStatus.Approved,
      declineReason: null,
    });
  });

  it("reports a Refund Request that doesn't exist", () => {
    expect(declineRefundRequest(db, 999, adminId, declineReason)).toEqual({
      outcome: "not-found",
    });
  });
});

describe("decision emails", () => {
  const learner = {
    learnerName: "Liam Learner",
    learnerEmail: "liam@example.com",
    courseTitle: "Introduction to TypeScript",
  };

  it("tells an approved learner the amount and that their progress is saved", () => {
    const email = buildApprovalEmail({ ...learner, amountRefunded: 7900 });

    expect(email.to).toBe("liam@example.com");
    expect(email.subject).toBe("Refund approved — Introduction to TypeScript");
    expect(email.body).toContain("$79.00");
    expect(email.body).toContain(
      "Your progress is saved. If you buy the course again, you'll pick up where you left off."
    );
  });

  it("gives a declined learner the Decline Reason and says they may ask again if they still qualify", () => {
    const email = buildDeclineEmail({
      ...learner,
      declineReason: "You have already finished most of the course.",
    });

    expect(email.to).toBe("liam@example.com");
    expect(email.subject).toBe("Refund declined — Introduction to TypeScript");
    expect(email.body).toContain("You have already finished most of the course.");
    expect(email.body).toContain(
      "If you still qualify, you can raise a new refund request from the course page."
    );
  });
});
