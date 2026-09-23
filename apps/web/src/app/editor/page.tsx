import type { Metadata } from 'next';
import { EditorWrapper } from '@/components/editor-wrapper';

export const metadata: Metadata = {
  title: 'Editor · komopdf',
  description: 'komopdf local document workspace',
};

export default function EditorPage() {
  return <EditorWrapper />;
}
