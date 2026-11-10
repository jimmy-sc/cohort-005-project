import { useEffect, useState } from "react";
import { useFetcher, type ShouldRevalidateFunctionArgs } from "react-router";
import { toast } from "sonner";
import { z } from "zod";
import type { Route } from "./+types/admin.refunds";
import { getCurrentUserId } from "~/lib/session";
import { parseFormData } from "~/lib/validation";
import { formatPrice } from "~/lib/utils";
import { db } from "~/db";
import { users, RefundStatus, UserRole } from "~/db/schema";
import { eq } from "drizzle-orm";
import {
  approveRefundRequest,
  buildApprovalEmail,
  buildDeclineEmail,
  declineRefundRequest,
  findRefundRequest,
  listRefundRequests,
  type DecisionResult,
} from "~/lib/refunds.server";
import { Card, CardContent } from "~/components/ui/card";
import { Button } from "~/components/ui/button";
import { Label } from "~/components/ui/label";
import { Textarea } from "~/components/ui/textarea";
import { AlertTriangle, Receipt } from "lucide-react";
import { data, isRouteErrorResponse, Link } from "react-router";

const refundDecisionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("approve"),
    refundRequestId: z.coerce.number().int(),
  }),
  z.object({
    intent: z.literal("decline"),
    refundRequestId: z.coerce.number().int(),
    declineReason: z
      .string()
      .trim()
      .min(10, "Tell the learner a little more about why.")
      .max(1000, "Please keep the reason under 1000 characters."),
  }),
]);

function getUserById(id: number) {
  return db.select().from(users).where(eq(users.id, id)).get();
}

async function requireAdmin(request: Request, signedOutMessage: string) {
  const currentUserId = await getCurrentUserId(request);

  if (!currentUserId) {
    throw data(signedOutMessage, { status: 401 });
  }

  const currentUser = getUserById(currentUserId);

  if (!currentUser || currentUser.role !== UserRole.Admin) {
    throw data("Only admins can decide on refund requests.", { status: 403 });
  }

  return currentUser;
}

export function meta() {
  return [
    { title: "Refund Requests — Cadence" },
    { name: "description", content: "Approve or decline refund requests" },
  ];
}

// React Router skips reloading after a 4xx action. A 409 means someone else
// decided the request, so reload to move it out of the Open list.
export function shouldRevalidate({
  actionStatus,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  if (actionStatus === 409) return true;
  return defaultShouldRevalidate;
}

export async function loader({ request }: Route.LoaderArgs) {
  await requireAdmin(
    request,
    "Select a user from the DevUI panel to manage refund requests."
  );

  return { refundRequests: listRefundRequests(db) };
}

function failedDecision(result: Exclude<DecisionResult, { outcome: "decided" }>) {
  if (result.outcome === "not-found") {
    return data({ error: "That refund request doesn't exist." }, { status: 404 });
  }
  return data(
    { error: "Someone already decided this refund request." },
    { status: 409 }
  );
}

export async function action({ request }: Route.ActionArgs) {
  const admin = await requireAdmin(request, "You must be logged in.");

  const formData = await request.formData();
  const parsed = parseFormData(formData, refundDecisionSchema);

  if (!parsed.success) {
    return data(
      { error: Object.values(parsed.errors)[0] ?? "Invalid input." },
      { status: 400 }
    );
  }

  const { refundRequestId } = parsed.data;

  if (parsed.data.intent === "approve") {
    const result = approveRefundRequest(db, refundRequestId, admin.id);
    if (result.outcome !== "decided") return failedDecision(result);

    const decided = findRefundRequest(db, refundRequestId)!;
    const email = buildApprovalEmail({
      ...decided,
      amountRefunded: decided.amountRefunded ?? decided.amountPaid,
    });
    console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);

    return { success: "Refund request approved." };
  }

  const { declineReason } = parsed.data;
  const result = declineRefundRequest(db, refundRequestId, admin.id, declineReason);
  if (result.outcome !== "decided") return failedDecision(result);

  const decided = findRefundRequest(db, refundRequestId)!;
  const email = buildDeclineEmail({ ...decided, declineReason });
  console.log(`[email] to=${email.to} subject=${email.subject}\n${email.body}`);

  return { success: "Refund request declined." };
}

type RefundRequestRow = ReturnType<typeof listRefundRequests>[number];

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function RequestSummary({ request }: { request: RefundRequestRow }) {
  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Link
          to={`/courses/${request.courseSlug}`}
          className="font-medium hover:underline"
        >
          {request.courseTitle}
        </Link>
        <span className="text-sm text-muted-foreground">
          {formatPrice(request.amountPaid)} · raised {formatDate(request.requestedAt)}
        </span>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">
        {request.learnerName} ({request.learnerEmail})
      </p>
      <p className="mt-2 text-sm">{request.reason}</p>
    </>
  );
}

type DecisionFetcher = ReturnType<typeof useFetcher<typeof action>>;

function OpenRequestCard({
  request,
  fetcher,
}: {
  request: RefundRequestRow;
  fetcher: DecisionFetcher;
}) {
  const [declining, setDeclining] = useState(false);
  const busy = fetcher.state !== "idle";

  return (
    <Card>
      <CardContent className="p-4">
        <RequestSummary request={request} />

        {declining ? (
          <fetcher.Form method="post" className="mt-4 space-y-2">
            <input type="hidden" name="intent" value="decline" />
            <input type="hidden" name="refundRequestId" value={request.id} />
            <Label htmlFor={`decline-reason-${request.id}`}>
              Decline Reason (the learner will see this)
            </Label>
            <Textarea
              id={`decline-reason-${request.id}`}
              name="declineReason"
              required
              minLength={10}
              maxLength={1000}
              rows={3}
            />
            <div className="flex gap-2">
              <Button type="submit" variant="destructive" disabled={busy}>
                Decline
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => setDeclining(false)}
              >
                Cancel
              </Button>
            </div>
          </fetcher.Form>
        ) : (
          <div className="mt-4 flex gap-2">
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="approve" />
              <input type="hidden" name="refundRequestId" value={request.id} />
              <Button type="submit" disabled={busy}>
                Approve {formatPrice(request.amountPaid)} refund
              </Button>
            </fetcher.Form>
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => setDeclining(true)}
            >
              Decline…
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DecidedRequestCard({ request }: { request: RefundRequestRow }) {
  const approved = request.status === RefundStatus.Approved;

  return (
    <Card>
      <CardContent className="p-4">
        <RequestSummary request={request} />
        <p className="mt-3 text-sm font-medium">
          {approved
            ? `Approved, ${formatPrice(request.amountRefunded)} refunded`
            : "Declined"}
          {request.resolvedAt && ` on ${formatDate(request.resolvedAt)}`}
          {request.resolvedByName && ` by ${request.resolvedByName}`}
        </p>
        {request.declineReason && (
          <p className="mt-1 text-sm text-muted-foreground">
            {request.declineReason}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export default function AdminRefunds({ loaderData }: Route.ComponentProps) {
  const { refundRequests } = loaderData;
  const open = refundRequests.filter((r) => r.status === RefundStatus.Open);
  const decided = refundRequests.filter((r) => r.status !== RefundStatus.Open);

  // One fetcher for the whole page, not one per card: a decided request moves
  // out of the Open list when the loader reloads, which unmounts its card
  // before the fetcher goes idle, so a per-card toast would never show.
  const fetcher = useFetcher<typeof action>();

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if ("success" in fetcher.data) toast.success(fetcher.data.success);
    if ("error" in fetcher.data) toast.error(fetcher.data.error);
  }, [fetcher.state, fetcher.data]);

  return (
    <div className="mx-auto max-w-4xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Refund Requests</span>
      </nav>

      <div className="mb-8">
        <h1 className="text-3xl font-bold">Refund Requests</h1>
        <p className="mt-1 text-muted-foreground">
          Approve or decline what learners have asked for, oldest first.
        </p>
      </div>

      <section className="mb-10">
        <h2 className="mb-3 text-lg font-semibold">
          Open ({open.length})
        </h2>
        {open.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center">
              <Receipt className="mx-auto mb-3 size-8 text-muted-foreground/50" />
              <p className="text-muted-foreground">
                No refund requests are waiting.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {open.map((request) => (
              <OpenRequestCard
                key={request.id}
                request={request}
                fetcher={fetcher}
              />
            ))}
          </div>
        )}
      </section>

      {decided.length > 0 && (
        <section>
          <h2 className="mb-3 text-lg font-semibold">Decided</h2>
          <div className="space-y-3">
            {decided.map((request) => (
              <DecidedRequestCard key={request.id} request={request} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading refund requests.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message =
        typeof error.data === "string"
          ? error.data
          : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Access denied";
      message =
        typeof error.data === "string"
          ? error.data
          : "Only admins can access this page.";
    } else {
      title = `Error ${error.status}`;
      message = typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <Link to="/">
          <Button>Go Home</Button>
        </Link>
      </div>
    </div>
  );
}
