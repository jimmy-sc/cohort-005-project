# A Refund Request gets exactly one decision

An admin decides an Open Refund Request once, Approved or Declined, and that decision is final. A Declined Refund Request is never reopened or reversed. If the learner still wants their money back, they raise a new Refund Request, and the normal eligibility rules apply to it.

We chose this so each row holds one decision (`resolvedAt`, `resolvedByUserId`, `decision_note`) and the history stays append-only. Letting admins reverse a decision would need a separate decision-history table and a migration of every existing row. The cost is that an admin who declines by mistake can't undo it; the learner has to raise a new request.
