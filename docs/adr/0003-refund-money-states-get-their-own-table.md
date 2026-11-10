# Refund money states will get their own table

The glossary treats the Refund Request (the learner's ask and the team's decision) and the Refund (the money) as separate things. For now both live in the `refunds` table: `status` is the request's state (open, approved, declined) and `amountRefunded` is set on approval. There is no payment provider yet, so Pending, Issued and Failed Refund are not stored anywhere.

When those money states arrive, they go in their own table that references the approved Refund Request. Do not add `pending`, `issued` or `failed` to `RefundStatus`. A Failed Refund leaves its Refund Request Approved, so the two lifecycles can't share one status column without losing that.
