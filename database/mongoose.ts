import mongoose from "mongoose";

declare global {
    var mongooseCache: {
        conn: typeof mongoose | null,
        promise: Promise<typeof mongoose> | null
    }
}
let cached = global.mongooseCache ||  (global.mongooseCache = { conn: null, promise: null });

export const connectToDatabase = async () => {
    const MONGODB_URI = process.env.MONGODB_URI;
    if(!MONGODB_URI) throw new Error("MONGODB_URI is not defined in environment variables");

    if(cached.conn) return cached.conn;

    if(!cached.promise) {
        cached.promise = mongoose.connect(MONGODB_URI, {bufferCommands:false});
    }
    try {
        cached.conn = await cached.promise;
        console.info('MongoDB connected successfully');
    } catch (error) {
        cached.promise = null;
        console.error('MongoDB connection error:', error);
        throw error;
    }
    return cached.conn;
}