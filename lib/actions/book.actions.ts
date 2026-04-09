'use server';

import {CreateBook, TextSegment} from "@/types";
import {connectToDatabase} from "@/database/mongoose";
import {escapeRegex, generateSlug, serializeData} from "@/lib/utils";
import Book from "@/database/models/book.model";
import BookSegment from "@/database/models/book-segment.model";
import mongoose from "mongoose";
import {getUserPlan} from "@/lib/subscription.server";
import {PLAN_LIMITS} from "@/lib/subscription-constants";
import {auth} from "@clerk/nextjs/server";
import UserBookCounter from "@/database/models/user-book-counter.model";

export const getAllBooks = async (search?: string) => {
    try {
        await connectToDatabase();

        let query = {};

        if (search) {
            const escapedSearch = escapeRegex(search);
            const regex = new RegExp(escapedSearch, 'i');
            query = {
                $or: [
                    { title: { $regex: regex } },
                    { author: { $regex: regex } },
                ]
            };
        }

        const books = await Book.find(query).sort({ createdAt: -1 }).lean();

        return {
            success: true,
            data: serializeData(books)
        }
    } catch (e) {
        console.error('Error connecting to database', e);
        return {
            success: false, error: 'FETCH_BOOKS_FAILED'
        }
    }
}

export const checkBookExists = async (title: string) => {
    try {
        await connectToDatabase();

        const slug = generateSlug(title);

        const existingBook = await Book.findOne({slug}).lean();

        if(existingBook) {
            return {
                exists: true,
                book: serializeData(existingBook)
            }
        }

        return {
            exists: false,
        }
    } catch (e) {
        console.error('Error checking book exists', e);
        return {
            exists: false, error: 'CHECK_BOOK_FAILED'
        }
    }
}

export const createBook = async (data: CreateBook) => {
    try {
        await connectToDatabase();

        const slug = generateSlug(data.title);

        const existingBook = await Book.findOne({slug}).lean();

        if(existingBook) {
            return {
                success: true,
                data: serializeData(existingBook),
                alreadyExists: true,
            }
        }

        const { userId } = await auth();

        if (!userId || userId !== data.clerkId) {
            return { success: false, error: "Unauthorized" };
        }

        const plan = await getUserPlan();
        const limits = PLAN_LIMITS[plan];

        const billingLimitResponse = {
            success: false as const,
            error: `You have reached the maximum number of books allowed for your ${plan} plan (${limits.maxBooks}). Please upgrade to add more books.`,
            isBillingError: true,
        };

        // Atomic quota reservation — unique index on clerkId means a quota-full
        // doc throws E11000 instead of letting a second upsert slip through.
        let reserved;
        try {
            reserved = await UserBookCounter.findOneAndUpdate(
                { clerkId: userId, count: { $lt: limits.maxBooks } },
                { $inc: { count: 1 } },
                { upsert: true, new: true }
            );
        } catch (e: any) {
            if (e.code === 11000) {
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

        let book;
        try {
            book = await Book.create({...data, clerkId: userId, slug, totalSegments: 0});
        } catch (e) {
            // Roll back the counter so the slot is not permanently consumed.
            await UserBookCounter.findOneAndUpdate({ clerkId: userId }, { $inc: { count: -1 } });
            throw e;
        }

        return {
            success: true,
            data: serializeData(book),
        }
    } catch (e) {
        console.error('Error creating a book', e);

        return {
            success: false,
            error: 'CREATE_BOOK_FAILED',
        }
    }
}

export const getBookBySlug = async (slug: string) => {
    try {
        await connectToDatabase();

        const book = await Book.findOne({ slug }).lean();

        if (!book) {
            return { success: false, error: 'Book not found' };
        }

        return {
            success: true,
            data: serializeData(book)
        }
    } catch (e) {
        console.error('Error fetching book by slug', e);
        return {
            success: false, error: 'FETCH_BOOK_FAILED'
        }
    }
}

export const saveBookSegments = async (bookId: string, clerkId: string, segments: TextSegment[]) => {
    try {
        await connectToDatabase();

        const { userId } = await auth();

        if (!userId) {
            return { success: false, error: 'Unauthorized' };
        }

        const book = await Book.findOne({ _id: bookId, clerkId: userId }).lean();

        if (!book) {
            return { success: false, error: 'Unauthorized' };
        }

        console.log('Saving book segments...');

        const segmentsToInsert = segments.map(({ text, segmentIndex, pageNumber, wordCount }) => ({
            clerkId: userId, bookId, content: text, segmentIndex, pageNumber, wordCount
        }));

        const session = await mongoose.startSession();
        try {
            await session.withTransaction(async () => {
                await BookSegment.insertMany(segmentsToInsert, { session });

                const updated = await Book.findByIdAndUpdate(
                    bookId,
                    { totalSegments: segments.length },
                    { session }
                );

                if (!updated) {
                    throw new Error(`Book ${bookId} not found during segment save`);
                }
            });
        } finally {
            await session.endSession();
        }

        console.log('Book segments saved successfully.');

        return {
            success: true,
            data: { segmentsCreated: segments.length}
        }
    } catch (e) {
        console.error('Error saving book segments', e);

        return {
            success: false,
            error: 'SAVE_SEGMENTS_FAILED',
        }
    }
}

// Searches book segments using MongoDB text search with regex fallback
export const searchBookSegments = async (bookId: string, query: string, limit: number = 5, userId?: string) => {
    try {
        await connectToDatabase();

        // Resolve identity: prefer explicit userId, fall back to session auth
        let resolvedUserId = userId;
        if (!resolvedUserId) {
            const { userId: sessionUserId } = await auth();
            resolvedUserId = sessionUserId ?? undefined;
        }

        if (!resolvedUserId) {
            return { success: false, error: 'Unauthorized', data: [] };
        }

        // Ownership check before any segment query
        const ownedBook = await Book.findOne({ _id: bookId, clerkId: resolvedUserId }).lean();
        if (!ownedBook) {
            return { success: false, error: 'Unauthorized', data: [] };
        }

        console.log(`Searching for: "${query}" in book ${bookId}`);

        const bookObjectId = new mongoose.Types.ObjectId(bookId);

        // Try MongoDB text search first (requires text index)
        let segments: Record<string, unknown>[] = [];
        try {
            segments = await BookSegment.find({
                bookId: bookObjectId,
                $text: { $search: query },
            })
                .select('_id bookId content segmentIndex pageNumber wordCount')
                .sort({ score: { $meta: 'textScore' } })
                .limit(limit)
                .lean();
        } catch {
            // Text index may not exist — fall through to regex fallback
            segments = [];
        }

        // Fallback: regex search matching ANY keyword
        if (segments.length === 0) {
            const keywords = query.split(/\s+/).filter((k) => k.length > 2);
            const pattern = keywords.map(escapeRegex).join('|');

            segments = await BookSegment.find({
                bookId: bookObjectId,
                content: { $regex: pattern, $options: 'i' },
            })
                .select('_id bookId content segmentIndex pageNumber wordCount')
                .sort({ segmentIndex: 1 })
                .limit(limit)
                .lean();
        }

        console.log(`Search complete. Found ${segments.length} results`);

        return {
            success: true,
            data: serializeData(segments),
        };
    } catch (error) {
        console.error('Error searching segments:', error);
        return {
            success: false,
            error: 'SEARCH_SEGMENTS_FAILED',
            data: [],
        };
    }
};