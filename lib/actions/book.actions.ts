'use server';

import {CreateBook, TextSegment} from "@/types";
import {connectToDatabase} from "@/database/mongoose";
import {escapeRegex, generateSlug, serializeData} from "@/lib/utils";
import Book from "@/database/models/book.model";
import BookSegment from "@/database/models/book-segment.model";
import mongoose from "mongoose";
import {getUserPlan} from "@/lib/subscription.server";
import {del} from "@vercel/blob";

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
            success: false,
            error: { name: (e as Error).name, message: (e as Error).message, code: (e as NodeJS.ErrnoException).code ?? null },
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
            exists: false,
            error: { name: (e as Error).name, message: (e as Error).message, code: (e as NodeJS.ErrnoException).code ?? null },
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

        // Todo: Check subscription limits before creating a book
        const { getUserPlan } = await import("@/lib/subscription.server");
        const { PLAN_LIMITS } = await import("@/lib/subscription-constants");

        const { auth } = await import("@clerk/nextjs/server");
        const { userId } = await auth();

        if (!userId || userId !== data.clerkId) {
            return { success: false, error: "Unauthorized" };
        }

        const plan = await getUserPlan();
        const limits = PLAN_LIMITS[plan];

        const bookCount = await Book.countDocuments({ clerkId: userId });

        if (bookCount >= limits.maxBooks) {
            const { revalidatePath } = await import("next/cache");
            revalidatePath("/");

            return {
                success: false,
                error: `You have reached the maximum number of books allowed for your ${plan} plan (${limits.maxBooks}). Please upgrade to add more books.`,
                isBillingError: true,
            };
        }

        const book = await Book.create({...data, clerkId: userId, slug, totalSegments: 0});

        return {
            success: true,
            data: serializeData(book),
        }
    } catch (e) {
        console.error('Error creating a book', e);
        return {
            success: false,
            error: { name: (e as Error).name, message: (e as Error).message, code: (e as NodeJS.ErrnoException).code ?? null },
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
            success: false,
            error: { name: (e as Error).name, message: (e as Error).message, code: (e as NodeJS.ErrnoException).code ?? null },
        }
    }
}

export const saveBookSegments = async (bookId: string, _clerkId: string, segments: TextSegment[]) => {
    try {
        await connectToDatabase();

        const { auth } = await import("@clerk/nextjs/server");
        const { userId } = await auth();

        if (!userId) {
            return { success: false, error: { name: 'Unauthorized', message: 'Not authenticated', code: null } };
        }

        const book = await Book.findById(bookId).lean();

        if (!book) {
            return { success: false, error: { name: 'NotFound', message: 'Book not found', code: null } };
        }

        if (book.clerkId !== userId) {
            return { success: false, error: { name: 'Unauthorized', message: 'You do not own this book', code: null } };
        }

        console.log('Saving book segments...');

        const segmentsToInsert = segments.map(({ text, segmentIndex, pageNumber, wordCount }) => ({
            clerkId: userId, bookId, content: text, segmentIndex, pageNumber, wordCount
        }));

        const session = await mongoose.startSession();
        try {
            await session.withTransaction(async () => {
                await BookSegment.insertMany(segmentsToInsert, { session });
                await Book.findByIdAndUpdate(bookId, { totalSegments: segments.length }, { session });
            });
        } catch (txErr) {
            const errCode = (txErr as { code?: number }).code;
            // Standalone MongoDB does not support transactions (code 20); fall back to non-transactional writes.
            if (errCode === 20) {
                await BookSegment.insertMany(segmentsToInsert);
                await Book.findByIdAndUpdate(bookId, { totalSegments: segments.length });
            } else {
                throw txErr;
            }
        } finally {
            await session.endSession();
        }

        console.log('Book segments saved successfully.');

        return {
            success: true,
            data: { segmentsCreated: segments.length }
        }
    } catch (e) {
        console.error('Error saving book segments', e);
        return {
            success: false,
            error: { name: (e as Error).name, message: (e as Error).message, code: (e as NodeJS.ErrnoException).code ?? null },
        }
    }
}

export const deleteBook = async (bookId: string) => {
    try {
        await connectToDatabase();
        const { auth } = await import("@clerk/nextjs/server");
        const { userId } = await auth();

        if (!userId) {
            return { success: false, error: { name: 'Unauthorized', message: 'Not authenticated', code: null } };
        }

        const book = await Book.findById(bookId).lean();

        if (!book) {
            return { success: false, error: { name: 'NotFound', message: 'Book not found', code: null } };
        }

        if (book.clerkId !== userId) {
            return { success: false, error: { name: 'Unauthorized', message: 'You do not own this book', code: null } };
        }

        const blobUrlsToDelete: string[] = [book.fileURL];
        if (book.coverURL) blobUrlsToDelete.push(book.coverURL);

        await del(blobUrlsToDelete);

        await Book.findByIdAndDelete(bookId);
        await BookSegment.deleteMany({ bookId });

        return { success: true };
    } catch (e) {
        console.error('Error deleting book', e);
        return {
            success: false,
            error: { name: (e as Error).name, message: (e as Error).message, code: (e as NodeJS.ErrnoException).code ?? null },
        };
    }
};

// Searches book segments using MongoDB text search with regex fallback
export const searchBookSegments = async (bookId: string, query: string, limit: number = 5) => {
    try {
        await connectToDatabase();

        const { auth } = await import("@clerk/nextjs/server");
        const { userId } = await auth();

        if (!userId) {
            return { success: false, error: { name: 'Unauthorized', message: 'Not authenticated', code: null }, data: [] };
        }

        if (!mongoose.isValidObjectId(bookId)) {
            return { success: false, error: { name: 'ValidationError', message: 'Invalid bookId format', code: null }, data: [] };
        }

        const bookObjectId = new mongoose.Types.ObjectId(bookId);

        const book = await Book.findById(bookObjectId).lean();

        if (!book) {
            return { success: false, error: { name: 'NotFound', message: 'Book not found', code: null }, data: [] };
        }

        if (book.clerkId !== userId) {
            return { success: false, error: { name: 'Unauthorized', message: 'You do not own this book', code: null }, data: [] };
        }

        console.log(`Searching for: "${query}" in book ${bookId}`);

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
            const keywords = query.trim().split(/\s+/).filter((k) => k.length > 2);
            if (keywords.length === 0) {
                 return {
                     success: true,
                     data: [],
                 };
            }
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
            error: (error as Error).message,
            data: [],
        };
    }
};