# A refund removes access but keeps learning history

Approving a Refund Request removes the learner's enrollment and their course rating, and nothing else. Lesson progress, quiz attempts, video watch events and comments stay, keyed to the user rather than the purchase, and carry over if the learner buys the course again.

We keep the history because the refund rule "less than 2 hours watched" adds up every watch event the learner has for the course, across all purchases. Deleting watch events on refund would reset that counter and let a learner buy, watch, get refunded and repeat. Keeping them also lets a returning learner pick up where they left off, which the approval email promises.

Progress rows without an enrollment are therefore expected, not orphans. Do not add a cleanup job for them.

## Considered Options

- **Delete all progress on refund.** Rejected: opens the refund loop above and loses data instructors' analytics may count.
- **Archive progress and start fresh on rebuy.** Rejected: more to build, still needs the watch events for the refund rule, and the learner gains nothing from losing their place.

## Consequences

- The rating is deleted so a refunded learner doesn't move the course average. Comments are kept because other learners may have replied to them.
- Refunded learners drop off the instructor's student list, since that list reads enrollments.
