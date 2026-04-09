'use server';

import {EndSessionResult, StartSessionResult} from "@/types";
import {connectToDatabase} from "@/database/mongoose";
import VoiceSession from "@/database/models/voice-session.model";
import MonthlySessionCounter from "@/database/models/monthly-session-counter.model";
import {PLAN_LIMITS, getCurrentBillingPeriodStart} from "@/lib/subscription-constants";
import {getUserPlan} from "@/lib/subscription.server";
import {auth} from "@clerk/nextjs/server";

export const startVoiceSession = async (clerkId: string, bookId: string): Promise<StartSessionResult> => {
    try {
        await connectToDatabase();

        const { userId } = await auth();

        if (!userId) {
            return { success: false, error: 'Unauthorized' };
        }

        const plan = await getUserPlan();
        const limits = PLAN_LIMITS[plan];
        const billingPeriodStart = getCurrentBillingPeriodStart();

        const billingLimitResponse = {
            success: false as const,
            error: `You have reached the monthly session limit for your ${plan} plan (${limits.maxSessionsPerMonth}). Please upgrade for more sessions.`,
            isBillingError: true,
        };

        let reserved;
        try {
            reserved = await MonthlySessionCounter.findOneAndUpdate(
                { clerkId: userId, billingPeriodStart, count: { $lt: limits.maxSessionsPerMonth } },
                { $inc: { count: 1 } },
                { upsert: true, new: true }
            );
        } catch (e: any) {
            if (e.code === 11000) {
                // Unique index blocked the upsert: a counter doc already exists with count >= max
                const { revalidatePath } = await import("next/cache");
                revalidatePath("/");
                return billingLimitResponse;
            }
            throw e;
        }

        if (!reserved) {
            const { revalidatePath } = await import("next/cache");
            revalidatePath("/");
            return billingLimitResponse;
        }

        const session = await VoiceSession.create({
            clerkId: userId,
            bookId,
            startedAt: new Date(),
            billingPeriodStart,
            durationSeconds: 0,
        });

        return {
            success: true,
            sessionId: session._id.toString(),
            maxDurationMinutes: limits.maxDurationPerSession,
        }
    } catch (e) {
        console.error('Error starting voice session', e);
        return { success: false, error: 'Failed to start voice session. Please try again later.' }
    }
}

export const endVoiceSession = async (sessionId: string, durationSeconds: number): Promise<EndSessionResult> => {
    try {
        await connectToDatabase();

        const result = await VoiceSession.findByIdAndUpdate(sessionId, {
            endedAt: new Date(),
            durationSeconds,
        });

        if(!result) return { success: false, error: 'Voice session not found.' }

        return { success: true }
    } catch (e) {
        console.error('Error ending voice session', e);
        return { success: false, error: 'Failed to end voice session. Please try again later.' }
    }
}
