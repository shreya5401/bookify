import { model, Schema, models } from "mongoose";

const MonthlySessionCounterSchema = new Schema({
    clerkId: { type: String, required: true },
    billingPeriodStart: { type: Date, required: true },
    count: { type: Number, required: true, default: 0 },
}, { timestamps: true });

MonthlySessionCounterSchema.index({ clerkId: 1, billingPeriodStart: 1 }, { unique: true });

const MonthlySessionCounter = models.MonthlySessionCounter || model('MonthlySessionCounter', MonthlySessionCounterSchema);

export default MonthlySessionCounter;
