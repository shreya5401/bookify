import { model, Schema, models } from "mongoose";

const UserBookCounterSchema = new Schema({
    clerkId: { type: String, required: true, unique: true },
    count: { type: Number, required: true, default: 0 },
}, { timestamps: true });

const UserBookCounter = models.UserBookCounter || model('UserBookCounter', UserBookCounterSchema);

export default UserBookCounter;
