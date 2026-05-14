import {
    internalMutation,
    mutation,
    query,
    MutationCtx,
} from "./_generated/server";
import { v } from "convex/values";
import { Id } from "./_generated/dataModel";
import { DURATIONS, WAITING_LIST_STATUS, TICKET_STATUS } from "./constants";
import { internal } from "./_generated/api";

/**
 * Helper function to group waiting list entries by event ID.
 * Used for batch processing expired offers by event.
 */
function groupByEvent(
    offers: Array<{ eventId: Id<"events">; _id: Id<"waitingList"> }>,
) {
    return offers.reduce(
        (acc, offer) => {
            const eventId = offer.eventId;
            if (!acc[eventId]) {
                acc[eventId] = [];
            }
            acc[eventId].push(offer);
            return acc;
        },
        {} as Record<Id<"events">, typeof offers>,
    );
}

/**
 * Query to get a user's current position in the waiting list for an event.
 * Returns null if user is not in queue, otherwise returns their entry with position.
 */
export const getQueuePosition = query({
    args: {
        eventId: v.id("events"),
        userId: v.string(),
    },
    handler: async (ctx, { eventId, userId }) => {
        const entry = await ctx.db
            .query("waitingList")
            .withIndex("by_user_event", (q) =>
                q.eq("userId", userId).eq("eventId", eventId),
            )
            .filter((q) =>
                q.neq(q.field("status"), WAITING_LIST_STATUS.EXPIRED),
            )
            .first();

        if (!entry) return null;

        const peopleAhead = await ctx.db
            .query("waitingList")
            .withIndex("by_event_status", (q) => q.eq("eventId", eventId))
            .filter((q) =>
                q.and(
                    q.lt(q.field("_creationTime"), entry._creationTime),
                    q.or(
                        q.eq(q.field("status"), WAITING_LIST_STATUS.WAITING),
                        q.eq(q.field("status"), WAITING_LIST_STATUS.OFFERED),
                    ),
                ),
            )
            .collect()
            .then((entries) => entries.length);

        return {
            ...entry,
            position: peopleAhead + 1,
        };
    },
});

// ✅ Plain internal helper — callable from mutations in any file
export async function processQueueHelper(
    ctx: MutationCtx,
    { eventId }: { eventId: Id<"events"> },
) {
    const event = await ctx.db.get(eventId);
    if (!event) throw new Error("Event not found");

    // Calculate available spots
    const purchasedCount = await ctx.db
        .query("tickets")
        .withIndex("by_event", (q) => q.eq("eventId", eventId))
        .collect()
        .then(
            (tickets) =>
                tickets.filter(
                    (t) =>
                        t.status === TICKET_STATUS.VALID ||
                        t.status === TICKET_STATUS.USED,
                ).length,
        );

    const now = Date.now();
    const activeOffers = await ctx.db
        .query("waitingList")
        .withIndex("by_event_status", (q) =>
            q.eq("eventId", eventId).eq("status", WAITING_LIST_STATUS.OFFERED),
        )
        .collect()
        .then(
            (entries) =>
                entries.filter((e) => (e.offerExpiresAt ?? 0) > now).length,
        );

    const availableSpots = event.totalTickets - (purchasedCount + activeOffers);

    if (availableSpots <= 0) return;

    // Get next users in line
    const waitingUsers = await ctx.db
        .query("waitingList")
        .withIndex("by_event_status", (q) =>
            q.eq("eventId", eventId).eq("status", WAITING_LIST_STATUS.WAITING),
        )
        .order("asc")
        .take(availableSpots);

    // Create time-limited offers for selected users
    for (const user of waitingUsers) {
        await ctx.db.patch(user._id, {
            status: WAITING_LIST_STATUS.OFFERED,
            offerExpiresAt: now + DURATIONS.TICKET_OFFER,
        });

        await ctx.scheduler.runAfter(
            DURATIONS.TICKET_OFFER,
            internal.waitingList.expireOffer,
            {
                waitingListId: user._id,
                eventId,
            },
        );
    }
}

/**
 * Mutation to process the waiting list queue and offer tickets to next eligible users.
 * ✅ Registered mutation — wraps the plain helper for external use
 */
export const processQueue = mutation({
    args: {
        eventId: v.id("events"),
    },
    handler: async (ctx, { eventId }) => {
        await processQueueHelper(ctx, { eventId });
    },
});

/**
 * Internal mutation to expire a single offer and process queue for next person.
 * Called by scheduled job when offer timer expires.
 */
export const expireOffer = internalMutation({
    args: {
        waitingListId: v.id("waitingList"),
        eventId: v.id("events"),
    },
    handler: async (ctx, { waitingListId, eventId }) => {
        const offer = await ctx.db.get(waitingListId);
        if (!offer || offer.status !== WAITING_LIST_STATUS.OFFERED) return;

        await ctx.db.patch(waitingListId, {
            status: WAITING_LIST_STATUS.EXPIRED,
        });

        // ✅ Call the plain helper instead of the registered mutation
        await processQueueHelper(ctx, { eventId });
    },
});

/**
 * Periodic cleanup job that acts as a fail-safe for expired offers.
 * Groups expired offers by event for efficient processing and updates queue
 * for each affected event after cleanup.
 */
export const cleanupExpiredOffers = internalMutation({
    args: {},
    handler: async (ctx) => {
        const now = Date.now();
        const expiredOffers = await ctx.db
            .query("waitingList")
            .filter((q) =>
                q.and(
                    q.eq(q.field("status"), WAITING_LIST_STATUS.OFFERED),
                    q.lt(q.field("offerExpiresAt"), now),
                ),
            )
            .collect();

        const grouped = groupByEvent(expiredOffers);

        for (const [eventId, offers] of Object.entries(grouped)) {
            await Promise.all(
                offers.map((offer) =>
                    ctx.db.patch(offer._id, {
                        status: WAITING_LIST_STATUS.EXPIRED,
                    }),
                ),
            );

            // ✅ Call the plain helper instead of the registered mutation
            await processQueueHelper(ctx, { eventId: eventId as Id<"events"> });
        }
    },
});

export const releaseTicket = mutation({
    args: {
        eventId: v.id("events"),
        waitingListId: v.id("waitingList"),
    },
    handler: async (ctx, { eventId, waitingListId }) => {
        const entry = await ctx.db.get(waitingListId);
        if (!entry || entry.status !== WAITING_LIST_STATUS.OFFERED) {
            throw new Error("No valid ticket offer found");
        }

        await ctx.db.patch(waitingListId, {
            status: WAITING_LIST_STATUS.EXPIRED,
        });

        // ✅ Call the plain helper instead of the registered mutation
        await processQueueHelper(ctx, { eventId });
    },
});
