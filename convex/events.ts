import { query, mutation, MutationCtx, QueryCtx } from "./_generated/server";
import { ConvexError, v } from "convex/values";
import { DURATIONS, WAITING_LIST_STATUS, TICKET_STATUS } from "./constants";
import { components, internal } from "./_generated/api";
import { processQueueHelper } from "./waitingList";
import { MINUTE, RateLimiter } from "@convex-dev/rate-limiter";
import { Id } from "./_generated/dataModel";

export type Metrics = {
    soldTickets: number;
    refundedTickets: number;
    cancelledTickets: number;
    revenue: number;
};

// Initialize rate limiter
const rateLimiter = new RateLimiter(components.rateLimiter, {
    queueJoin: {
        kind: "fixed window",
        rate: 3, // 3 joins allowed
        period: 30 * MINUTE, // in 30 minutes
    },
});

// ✅ Plain internal helper — callable from other mutations/queries
export async function checkAvailabilityHelper(
    ctx: QueryCtx | MutationCtx,
    { eventId }: { eventId: Id<"events"> },
) {
    const event = await ctx.db.get(eventId);
    if (!event) throw new Error("Event not found");

    // Count total purchased tickets
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

    // Count current valid offers
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

    return {
        available: availableSpots > 0,
        availableSpots,
        totalTickets: event.totalTickets,
        purchasedCount,
        activeOffers,
    };
}

export const get = query({
    args: {},
    handler: async (ctx) => {
        return await ctx.db
            .query("events")
            .filter((q) => q.eq(q.field("is_cancelled"), undefined))
            .collect();
    },
});

export const getById = query({
    args: { eventId: v.id("events") },
    handler: async (ctx, { eventId }) => {
        return await ctx.db.get(eventId);
    },
});

export const create = mutation({
    args: {
        name: v.string(),
        description: v.string(),
        location: v.string(),
        eventDate: v.number(),
        price: v.number(),
        totalTickets: v.number(),
        userId: v.string(),
    },
    handler: async (ctx, args) => {
        const eventId = await ctx.db.insert("events", {
            name: args.name,
            description: args.description,
            location: args.location,
            eventDate: args.eventDate,
            price: args.price,
            totalTickets: args.totalTickets,
            userId: args.userId,
        });
        return eventId;
    },
});

// ✅ Registered query — wraps the helper for external use
export const checkAvailability = query({
    args: { eventId: v.id("events") },
    handler: async (ctx, { eventId }) => {
        return await checkAvailabilityHelper(ctx, { eventId });
    },
});

// Join waiting list for an event
export const joinWaitingList = mutation({
    args: { eventId: v.id("events"), userId: v.string() },
    handler: async (ctx, { eventId, userId }) => {
        // Rate limit check
        const status = await rateLimiter.limit(ctx, "queueJoin", {
            key: userId,
        });
        if (!status.ok) {
            throw new ConvexError(
                `You've joined the waiting list too many times. Please wait ${Math.ceil(
                    status.retryAfter / (60 * 1000),
                )} minutes before trying again.`,
            );
        }

        const existingEntry = await ctx.db
            .query("waitingList")
            .withIndex("by_user_event", (q) =>
                q.eq("userId", userId).eq("eventId", eventId),
            )
            .filter((q) =>
                q.neq(q.field("status"), WAITING_LIST_STATUS.EXPIRED),
            )
            .first();

        if (existingEntry) {
            throw new Error("Already in waiting list for this event");
        }

        const event = await ctx.db.get(eventId);
        if (!event) throw new Error("Event not found");

        // ✅ Call the plain helper instead of the registered query
        const { available } = await checkAvailabilityHelper(ctx, { eventId });

        const now = Date.now();

        if (available) {
            const waitingListId = await ctx.db.insert("waitingList", {
                eventId,
                userId,
                status: WAITING_LIST_STATUS.OFFERED,
                offerExpiresAt: now + DURATIONS.TICKET_OFFER,
            });

            await ctx.scheduler.runAfter(
                DURATIONS.TICKET_OFFER,
                internal.waitingList.expireOffer,
                {
                    waitingListId,
                    eventId,
                },
            );
        } else {
            await ctx.db.insert("waitingList", {
                eventId,
                userId,
                status: WAITING_LIST_STATUS.WAITING,
            });
        }

        return {
            success: true,
            status: available
                ? WAITING_LIST_STATUS.OFFERED
                : WAITING_LIST_STATUS.WAITING,
            message: available
                ? "Ticket offered - you have 15 minutes to purchase"
                : "Added to waiting list - you'll be notified when a ticket becomes available",
        };
    },
});

// Purchase ticket
export const purchaseTicket = mutation({
    args: {
        eventId: v.id("events"),
        userId: v.string(),
        waitingListId: v.id("waitingList"),
        paymentInfo: v.object({
            paymentIntentId: v.string(),
            amount: v.number(),
        }),
    },
    handler: async (ctx, { eventId, userId, waitingListId, paymentInfo }) => {
        console.log("Starting purchaseTicket handler", {
            eventId,
            userId,
            waitingListId,
        });

        const waitingListEntry = await ctx.db.get(waitingListId);
        console.log("Waiting list entry:", waitingListEntry);

        if (!waitingListEntry) {
            console.error("Waiting list entry not found");
            throw new Error("Waiting list entry not found");
        }

        if (waitingListEntry.status !== WAITING_LIST_STATUS.OFFERED) {
            console.error("Invalid waiting list status", {
                status: waitingListEntry.status,
            });
            throw new Error(
                "Invalid waiting list status - ticket offer may have expired",
            );
        }

        if (waitingListEntry.userId !== userId) {
            console.error("User ID mismatch", {
                waitingListUserId: waitingListEntry.userId,
                requestUserId: userId,
            });
            throw new Error("Waiting list entry does not belong to this user");
        }

        const event = await ctx.db.get(eventId);
        console.log("Event details:", event);

        if (!event) {
            console.error("Event not found", { eventId });
            throw new Error("Event not found");
        }

        if (event.is_cancelled) {
            console.error("Attempted purchase of cancelled event", { eventId });
            throw new Error("Event is no longer active");
        }

        try {
            console.log("Creating ticket with payment info", paymentInfo);
            await ctx.db.insert("tickets", {
                eventId,
                userId,
                purchasedAt: Date.now(),
                status: TICKET_STATUS.VALID,
                paymentIntentId: paymentInfo.paymentIntentId,
                amount: paymentInfo.amount,
            });

            console.log("Updating waiting list status to purchased");
            await ctx.db.patch(waitingListId, {
                status: WAITING_LIST_STATUS.PURCHASED,
            });

            console.log("Processing queue for next person");
            // ✅ Call the plain helper instead of the registered mutation
            await processQueueHelper(ctx, { eventId });

            console.log("Purchase ticket completed successfully");
        } catch (error) {
            console.error("Failed to complete ticket purchase:", error);
            throw new Error(`Failed to complete ticket purchase: ${error}`);
        }
    },
});

export const getUserTickets = query({
    args: { userId: v.string() },
    handler: async (ctx, { userId }) => {
        const tickets = await ctx.db
            .query("tickets")
            .withIndex("by_user", (q) => q.eq("userId", userId))
            .collect();

        const ticketsWithEvents = await Promise.all(
            tickets.map(async (ticket) => {
                const event = await ctx.db.get(ticket.eventId);
                return {
                    ...ticket,
                    event,
                };
            }),
        );

        return ticketsWithEvents;
    },
});

export const getUserWaitingList = query({
    args: { userId: v.string() },
    handler: async (ctx, { userId }) => {
        const entries = await ctx.db
            .query("waitingList")
            .withIndex("by_user", (q) => q.eq("userId", userId))
            .collect();

        const entriesWithEvents = await Promise.all(
            entries.map(async (entry) => {
                const event = await ctx.db.get(entry.eventId);
                return {
                    ...entry,
                    event,
                };
            }),
        );

        return entriesWithEvents;
    },
});

export const getEventAvailability = query({
    args: { eventId: v.id("events") },
    handler: async (ctx, { eventId }) => {
        const event = await ctx.db.get(eventId);
        if (!event) throw new Error("Event not found");

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
                q
                    .eq("eventId", eventId)
                    .eq("status", WAITING_LIST_STATUS.OFFERED),
            )
            .collect()
            .then(
                (entries) =>
                    entries.filter((e) => (e.offerExpiresAt ?? 0) > now).length,
            );

        const totalReserved = purchasedCount + activeOffers;

        return {
            isSoldOut: totalReserved >= event.totalTickets,
            totalTickets: event.totalTickets,
            purchasedCount,
            activeOffers,
            remainingTickets: Math.max(0, event.totalTickets - totalReserved),
        };
    },
});

export const search = query({
    args: { searchTerm: v.string() },
    handler: async (ctx, { searchTerm }) => {
        const events = await ctx.db
            .query("events")
            .filter((q) => q.eq(q.field("is_cancelled"), undefined))
            .collect();

        return events.filter((event) => {
            const searchTermLower = searchTerm.toLowerCase();
            return (
                event.name.toLowerCase().includes(searchTermLower) ||
                event.description.toLowerCase().includes(searchTermLower) ||
                event.location.toLowerCase().includes(searchTermLower)
            );
        });
    },
});

export const getSellerEvents = query({
    args: { userId: v.string() },
    handler: async (ctx, { userId }) => {
        const events = await ctx.db
            .query("events")
            .filter((q) => q.eq(q.field("userId"), userId))
            .collect();

        const eventsWithMetrics = await Promise.all(
            events.map(async (event) => {
                const tickets = await ctx.db
                    .query("tickets")
                    .withIndex("by_event", (q) => q.eq("eventId", event._id))
                    .collect();

                const validTickets = tickets.filter(
                    (t) => t.status === "valid" || t.status === "used",
                );
                const refundedTickets = tickets.filter(
                    (t) => t.status === "refunded",
                );
                const cancelledTickets = tickets.filter(
                    (t) => t.status === "cancelled",
                );

                const metrics: Metrics = {
                    soldTickets: validTickets.length,
                    refundedTickets: refundedTickets.length,
                    cancelledTickets: cancelledTickets.length,
                    revenue: validTickets.length * event.price,
                };

                return {
                    ...event,
                    metrics,
                };
            }),
        );

        return eventsWithMetrics;
    },
});

export const updateEvent = mutation({
    args: {
        eventId: v.id("events"),
        name: v.string(),
        description: v.string(),
        location: v.string(),
        eventDate: v.number(),
        price: v.number(),
        totalTickets: v.number(),
    },
    handler: async (ctx, args) => {
        const { eventId, ...updates } = args;

        const event = await ctx.db.get(eventId);
        if (!event) throw new Error("Event not found");

        const soldTickets = await ctx.db
            .query("tickets")
            .withIndex("by_event", (q) => q.eq("eventId", eventId))
            .filter((q) =>
                q.or(
                    q.eq(q.field("status"), "valid"),
                    q.eq(q.field("status"), "used"),
                ),
            )
            .collect();

        if (updates.totalTickets < soldTickets.length) {
            throw new Error(
                `Cannot reduce total tickets below ${soldTickets.length} (number of tickets already sold)`,
            );
        }

        await ctx.db.patch(eventId, updates);
        return eventId;
    },
});

export const cancelEvent = mutation({
    args: { eventId: v.id("events") },
    handler: async (ctx, { eventId }) => {
        const event = await ctx.db.get(eventId);
        if (!event) throw new Error("Event not found");

        const tickets = await ctx.db
            .query("tickets")
            .withIndex("by_event", (q) => q.eq("eventId", eventId))
            .filter((q) =>
                q.or(
                    q.eq(q.field("status"), "valid"),
                    q.eq(q.field("status"), "used"),
                ),
            )
            .collect();

        if (tickets.length > 0) {
            throw new Error(
                "Cannot cancel event with active tickets. Please refund all tickets first.",
            );
        }

        await ctx.db.patch(eventId, {
            is_cancelled: true,
        });

        const waitingListEntries = await ctx.db
            .query("waitingList")
            .withIndex("by_event_status", (q) => q.eq("eventId", eventId))
            .collect();

        for (const entry of waitingListEntries) {
            await ctx.db.delete(entry._id);
        }

        return { success: true };
    },
});
