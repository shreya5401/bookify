import { redirect } from 'next/navigation';
import Image from 'next/image';
import Link from 'next/link';
import { auth } from '@clerk/nextjs/server';
import { ArrowLeft, Mic, MicOff } from 'lucide-react';
import { getBookBySlug } from '@/lib/actions/book.actions';
import VapiControls from '@/components/VapiControls';

const Page = async ({ params }: { params: Promise<{ slug: string }> }) => {
    const { userId } = await auth();
    if (!userId) redirect('/sign-in');

    const { slug } = await params;
    const result = await getBookBySlug(slug);

    if (!result.success || !result.data) redirect('/');

    const { title, author, coverURL, voice } = result.data;

    return (
        <div className="book-page-container">
            <Link href="/" className="back-btn-floating" aria-label="Back to library">
                <ArrowLeft className="w-5 h-5 text-[#212a3b]" />
            </Link>

            {/* Transcript area */}
            <VapiControls book={result.data} />
        </div>
    );
};

export default Page;
