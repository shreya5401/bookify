'use client';

import { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Upload, ImageIcon, X, Loader2 } from 'lucide-react';

import { UploadSchema } from '@/lib/zod';
import { voiceOptions, voiceCategories, DEFAULT_VOICE } from '@/lib/constants';
import { BookUploadFormValues } from '@/types';
import {
    Form,
    FormControl,
    FormField,
    FormItem,
    FormLabel,
    FormMessage,
} from '@/components/ui/form';
import { useAuth } from '@clerk/nextjs';
import {toast} from 'sonner';
import {checkBookExists, createBook, deleteBook, saveBookSegments} from "@/lib/actions/book.actions";
import { useRouter } from 'next/navigation';
import {parsePDFFile} from "@/lib/utils";
import {upload} from "@vercel/blob/client";

// ── Loading Overlay ──────────────────────────────────────────────────────────

function LoadingOverlay() {
    return (
        <div className="loading-wrapper">
            <div className="loading-shadow-wrapper shadow-soft-lg bg-white">
                <div className="loading-shadow">
                    <Loader2 className="loading-animation w-12 h-12 text-[#663820]" />
                    <p className="loading-title">Processing your book…</p>
                    <div className="loading-progress">
                        <div className="loading-progress-item">
                            <span className="loading-progress-status" />
                            <span>Uploading files</span>
                        </div>
                        <div className="loading-progress-item">
                            <span className="loading-progress-status" />
                            <span>Extracting text</span>
                        </div>
                        <div className="loading-progress-item">
                            <span className="loading-progress-status" />
                            <span>Preparing assistant</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

// ── File Dropzone ────────────────────────────────────────────────────────────

interface DropzoneProps {
    accept: string;
    icon: React.ReactNode;
    placeholder: string;
    hint: string;
    value: File | undefined;
    onChange: (file: File | undefined) => void;
    disabled?: boolean;
    error?: string;
}

function Dropzone({
    accept,
    icon,
    placeholder,
    hint,
    value,
    onChange,
    disabled,
    error,
}: DropzoneProps) {
    const inputRef = useRef<HTMLInputElement>(null);

    function handleClick() {
        if (!disabled) inputRef.current?.click();
    }

    function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
        const file = e.target.files?.[0];
        if (file) onChange(file);
        e.target.value = '';
    }

    function handleRemove(e: React.MouseEvent) {
        e.stopPropagation();
        onChange(undefined);
    }

    const hasFile = !!value;

    return (
        <div
            className={[
                'upload-dropzone border-2 border-dashed',
                error ? 'border-red-400' : 'border-[rgba(33,42,59,0.2)]',
                hasFile ? 'upload-dropzone-uploaded' : '',
                disabled ? 'opacity-50 cursor-not-allowed' : '',
            ]
                .filter(Boolean)
                .join(' ')}
            onClick={handleClick}
            role="button"
            tabIndex={disabled ? -1 : 0}
            onKeyDown={(e) => e.key === 'Enter' && handleClick()}
            aria-disabled={disabled}
        >
            <input
                ref={inputRef}
                type="file"
                accept={accept}
                className="hidden"
                onChange={handleChange}
                disabled={disabled}
            />

            {hasFile ? (
                <div className="flex items-center gap-3 px-4">
                    <span className="upload-dropzone-icon !w-6 !h-6 !mb-0">{icon}</span>
                    <span className="upload-dropzone-text truncate max-w-[280px]">
                        {value.name}
                    </span>
                    <button
                        type="button"
                        className="upload-dropzone-remove ml-auto"
                        onClick={handleRemove}
                        aria-label="Remove file"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </div>
            ) : (
                <>
                    <span className="upload-dropzone-icon">{icon}</span>
                    <p className="upload-dropzone-text">{placeholder}</p>
                    <p className="upload-dropzone-hint">{hint}</p>
                </>
            )}
        </div>
    );
}

// ── Voice Selector ───────────────────────────────────────────────────────────

interface VoiceSelectorProps {
    value: string;
    onChange: (id: string) => void;
    disabled?: boolean;
}

function VoiceSelector({ value, onChange, disabled }: VoiceSelectorProps) {
    const groups = [
        { label: 'Male Voices', keys: voiceCategories.male },
        { label: 'Female Voices', keys: voiceCategories.female },
    ] as const;

    return (
        <div className="space-y-4">
            {groups.map(({ label, keys }) => (
                <div key={label}>
                    <p className="text-sm font-medium text-[#3d485e] mb-2">{label}</p>
                    <div className="voice-selector-options flex-wrap">
                        {keys.map((key) => {
                            const opt = voiceOptions[key as keyof typeof voiceOptions];
                            const isSelected = value === opt.id;
                            return (
                                <button
                                    key={key}
                                    type="button"
                                    disabled={disabled}
                                    onClick={() => onChange(opt.id)}
                                    className={[
                                        'voice-selector-option flex-col !items-start text-left',
                                        isSelected
                                            ? 'voice-selector-option-selected'
                                            : 'voice-selector-option-default',
                                        disabled ? 'voice-selector-option-disabled' : '',
                                    ]
                                        .filter(Boolean)
                                        .join(' ')}
                                >
                                    <span className="font-semibold text-[#212a3b] text-base">
                                        {opt.name}
                                    </span>
                                    <span className="text-xs text-[#3d485e] mt-0.5 leading-snug">
                                        {opt.description}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            ))}
        </div>
    );
}

// ── Main Form ────────────────────────────────────────────────────────────────

const UploadForm = () => {
    const [isSubmitting, setIsSubmitting] = useState(false);
    const {userId} = useAuth()
    const router = useRouter();

    const form = useForm<BookUploadFormValues>({
        resolver: zodResolver(UploadSchema),
        defaultValues: {
            title: '',
            author: '',
            voice: '',
            pdfFile: undefined,
            coverImage: undefined,
        },
    });

    async function onSubmit(values: BookUploadFormValues) {
        if(!userId){
            return toast.error('Please login to upload books');
        }
        setIsSubmitting(true);

        try {
            const existsCheck = await checkBookExists(values.title);
            if(existsCheck.exists && existsCheck.book){
                toast.info('A book with this title already exists. Please choose a different title or delete the existing book first.');
                form.reset();
                router.push(`/books/${existsCheck.book.slug}`)
                return; 
            }
            const fileTitle = values.title.replace(/\s+/g, '-').toLowerCase();
            const pdfFile = values.pdfFile;

            const parsedPDF = await parsePDFFile(pdfFile);

            if(parsedPDF.content.length === 0) {
                toast.error("Failed to parse PDF. Please try again with a different file.");
                return;
            }

            const uploadedPdfBlob = await upload(fileTitle, pdfFile, {
                access: 'public',
                handleUploadUrl: '/api/upload',
                contentType: 'application/pdf'
            });

            let coverUrl: string;

            if(values.coverImage) {
                const coverFile = values.coverImage;
                const uploadedCoverBlob = await upload(`${fileTitle}_cover.png`, coverFile, {
                    access: 'public',
                    handleUploadUrl: '/api/upload',
                    contentType: coverFile.type
                });
                coverUrl = uploadedCoverBlob.url;
            } else {
                const response = await fetch(parsedPDF.cover)
                const blob = await response.blob();

                const uploadedCoverBlob = await upload(`${fileTitle}_cover.png`, blob, {
                    access: 'public',
                    handleUploadUrl: '/api/upload',
                    contentType: 'image/png'
                });
                coverUrl = uploadedCoverBlob.url;
            }

            const book = await createBook({
                clerkId: userId,
                title: values.title,
                author: values.author,
                voice: values.voice,
                fileURL: uploadedPdfBlob.url,
                fileBlobKey: uploadedPdfBlob.pathname,
                coverURL: coverUrl,
                fileSize: pdfFile.size,
            });

            if(!book.success) {
                const message =
                    typeof book.error === 'string'
                        ? book.error
                        : book.error?.message ?? 'Failed to create book';
                toast.error(message);
                if (book.isBillingError) {
                    router.push("/subscriptions");
                }
                return;
            }

            if(book.alreadyExists) {
                toast.info("Book with same title already exists.");
                form.reset()
                router.push(`/books/${book.data.slug}`)
                return;
            }

            const segments = await saveBookSegments(book.data._id, userId, parsedPDF.content);

            if(!segments.success) {
                await deleteBook(book.data._id, userId);
                toast.error("Failed to save book segments");
                throw new Error("Failed to save book segments");
            }

            form.reset();
            router.push('/');

        } catch (error){
            console.error(error);
            toast.error('An error occurred while uploading your book. Please try again.');
        }
        finally {
            setIsSubmitting(false);
        }
    }

    return (
        <>
            {isSubmitting && <LoadingOverlay />}

            <div className="new-book-wrapper">
                <Form {...form}>
                    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-8">
                        {/* PDF Upload */}
                        <FormField
                            control={form.control}
                            name="pdfFile"
                            render={({ field, fieldState }) => (
                                <FormItem>
                                    <label className="form-label">PDF File</label>
                                    <Dropzone
                                        accept="application/pdf"
                                        icon={<Upload />}
                                        placeholder="Click to upload PDF"
                                        hint="PDF file (max 50MB)"
                                        value={field.value as File | undefined}
                                        onChange={field.onChange}
                                        disabled={isSubmitting}
                                        error={fieldState.error?.message}
                                    />
                                    <FormMessage />
                                </FormItem>
                            )}
                        />

                        {/* Cover Image Upload */}
                        <FormField
                            control={form.control}
                            name="coverImage"
                            render={({ field, fieldState }) => (
                                <FormItem>
                                    <label className="form-label">Cover Image</label>
                                    <Dropzone
                                        accept="image/jpeg,image/jpg,image/png,image/webp"
                                        icon={<ImageIcon />}
                                        placeholder="Click to upload cover image"
                                        hint="Leave empty to auto-generate from PDF"
                                        value={field.value as File | undefined}
                                        onChange={field.onChange}
                                        disabled={isSubmitting}
                                        error={fieldState.error?.message}
                                    />
                                    <FormMessage />
                                </FormItem>
                            )}
                        />

                        {/* Title */}
                        <FormField
                            control={form.control}
                            name="title"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel className="form-label">Title</FormLabel>
                                    <FormControl>
                                        <input
                                            {...field}
                                            className="form-input border border-[rgba(33,42,59,0.12)] focus:outline-none focus:border-[#663820]"
                                            placeholder="ex: Rich Dad Poor Dad"
                                            disabled={isSubmitting}
                                        />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />

                        {/* Author */}
                        <FormField
                            control={form.control}
                            name="author"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel className="form-label">Author Name</FormLabel>
                                    <FormControl>
                                        <input
                                            {...field}
                                            className="form-input border border-[rgba(33,42,59,0.12)] focus:outline-none focus:border-[#663820]"
                                            placeholder="ex: Robert Kiyosaki"
                                            disabled={isSubmitting}
                                        />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />

                        {/* Voice Selector */}
                        <FormField
                            control={form.control}
                            name="voice"
                            render={({ field }) => (
                                <FormItem>
                                    <label className="form-label">Choose Assistant Voice</label>
                                    <VoiceSelector
                                        value={field.value}
                                        onChange={field.onChange}
                                        disabled={isSubmitting}
                                    />
                                    <FormMessage />
                                </FormItem>
                            )}
                        />

                        {/* Submit */}
                        <button
                            type="submit"
                            className="form-btn"
                            disabled={isSubmitting}
                        >
                            Begin Synthesis
                        </button>
                    </form>
                </Form>
            </div>
        </>
    );
};

export default UploadForm;
