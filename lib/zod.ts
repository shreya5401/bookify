import { z } from 'zod';
import {
    ACCEPTED_IMAGE_TYPES,
    ACCEPTED_PDF_TYPES,
    MAX_FILE_SIZE,
    MAX_IMAGE_SIZE,
} from '@/lib/constants';

export const UploadSchema = z.object({
    pdfFile: z
        .instanceof(File)
        .refine((f) => f.size <= MAX_FILE_SIZE, 'PDF must be under 50MB')
        .refine(
            (f) => ACCEPTED_PDF_TYPES.includes(f.type),
            'Only PDF files are accepted'
        ),
    coverImage: z
        .instanceof(File)
        .refine((f) => f.size <= MAX_IMAGE_SIZE, 'Image must be under 10MB')
        .refine(
            (f) => ACCEPTED_IMAGE_TYPES.includes(f.type),
            'Only JPEG, PNG, or WebP images are accepted'
        )
        .optional(),
    title: z
        .string()
        .min(1, 'Title is required')
        .max(200, 'Title must be under 200 characters'),
    author: z
        .string()
        .min(1, 'Author name is required')
        .max(100, 'Author must be under 100 characters'),
    voice: z.string().min(1, 'Please select a voice'),
});
