import type { UiLocale } from '@pdf-editor/editor/i18n-locales';

export type ToolTask = 'edit-text' | 'annotate' | 'pages' | 'export-image';
export type ToolContent = {
  slug: string; task: ToolTask; title: string; description: string; intro: string; cta: string;
  steps: readonly { title: string; text: string }[];
  limits: readonly string[];
  faq: readonly { question: string; answer: string }[];
};

// Source strings are translation keys. Keep this content separate from the PDF engine.
export const TOOLS: readonly ToolContent[] = [
  {
    slug: 'edit-pdf-text', task: 'edit-text', title: 'Edit PDF text online',
    description: 'Change existing PDF text in your browser for free. No account, installation or file upload for ordinary editing.',
    intro: 'Correct a typo, update a paragraph or add new text directly on the PDF page. Your document stays on your device during ordinary editing.',
    cta: 'Open a PDF to edit text',
    steps: [
      { title: 'Open your PDF', text: 'Choose a PDF from your device. Password-protected files ask for the password before opening.' },
      { title: 'Select and change the text', text: 'Choose Edit, then double-click existing text on the page. Type your changes and use the formatting toolbar. To add text, use the text tool.' },
      { title: 'Review and download', text: 'Check line breaks, fonts and nearby content. Use Download copy to save a new PDF without overwriting the original.' },
    ],
    limits: [
      'This tool edits existing text objects. Text inside a scanned image needs OCR, which is not available in the web editor.',
      'PDF text does not behave like a Word document. Complex fonts, rotated text and layouts may need manual review.',
    ],
    faq: [
      { question: 'Can I edit PDF text without signing up?', answer: 'Yes. Ordinary PDF text editing and saving are free and do not require an account. Optional KOMO conversations require sign-in.' },
      { question: 'Why can’t I select the words in my PDF?', answer: 'The page may be a scan or an image rather than actual text. The web editor does not include OCR. You can add a new text box, but that does not turn the scanned words into editable text.' },
      { question: 'Will changing text reflow the entire document?', answer: 'No. Editable paragraphs can continue onto another page when needed, but unrelated artwork and the whole document do not automatically reflow like a word processor.' },
    ],
  },
  {
    slug: 'delete-pdf-pages', task: 'pages', title: 'Delete pages from a PDF',
    description: 'Remove unwanted PDF pages and reorder the pages you keep. Free browser-based page organization without an account.',
    intro: 'Remove blank pages, drop an outdated section or put pages in the right order. Review thumbnails before saving a separate PDF copy.',
    cta: 'Open a PDF to organize pages',
    steps: [
      { title: 'Open the page overview', text: 'Open your PDF and choose Pages to see its thumbnails. Adjust the thumbnail size to inspect the document.' },
      { title: 'Select, delete or reorder', text: 'Select the pages to remove. Use Ctrl or Command to select several pages, or Shift for a range, then choose Delete. Drag thumbnails to change their order.' },
      { title: 'Check the result and save', text: 'Review the remaining pages and their order. Undo a mistake before saving, then choose Download copy for the updated PDF.' },
    ],
    limits: [
      'At least one page must remain in the document. Deleting a page removes everything on that page from the saved copy.',
      'To keep selected pages as a separate file instead, use Extract. Page extraction and deletion are different operations.',
    ],
    faq: [
      { question: 'Can I delete several PDF pages at once?', answer: 'Yes. Select multiple thumbnails with Ctrl or Command, or select a range with Shift, and apply Delete to the selection.' },
      { question: 'Can I restore a page after deleting it?', answer: 'Use Undo while the editing session is open. Keep your original PDF as a backup; a downloaded copy no longer contains the pages you removed.' },
      { question: 'Does deleting pages upload my PDF?', answer: 'No. Ordinary page organization and PDF saving run locally in your browser. Optional online AI and document translation are separate actions.' },
    ],
  },
  {
    slug: 'pdf-to-image', task: 'export-image', title: 'Convert PDF pages to JPG or PNG',
    description: 'Export PDF pages as JPG or PNG images in your browser. Choose pages and resolution; multiple images download as a ZIP.',
    intro: 'Make image copies of PDF pages for presentations, previews or sharing. Export the current edited document, not just the original file.',
    cta: 'Open a PDF to export images',
    steps: [
      { title: 'Open and review your PDF', text: 'Choose your PDF from the device. Make any text, image or page changes you want to include in the exported images.' },
      { title: 'Choose an image format', text: 'Open Export and choose PNG or JPEG. Select the pages and resolution you need. JPEG is useful for photos; PNG keeps sharp text and line art.' },
      { title: 'Download the images', text: 'Run the export and save the result. A single page downloads as one image; multiple pages are packaged in a ZIP file.' },
    ],
    limits: [
      'Images contain rendered page pixels, not editable text or a searchable PDF text layer.',
      'Browser image export allows up to 200 output pages and 64 MiB of encoded output. Use fewer pages or lower resolution for large documents.',
    ],
    faq: [
      { question: 'Can I convert a PDF to JPG without uploading it?', answer: 'Yes. PDF rendering and JPG or PNG export run on your device in the web editor. No account is required.' },
      { question: 'Should I choose JPG or PNG?', answer: 'Choose JPEG for photographic pages and smaller files. Choose PNG for crisp text, diagrams and lossless page images. Higher resolution increases file size.' },
      { question: 'Can I export only a few pages?', answer: 'Yes. Set the desired page range in Export. For multiple selected pages, the resulting images are downloaded together as a ZIP.' },
    ],
  },
];
export const ANNOTATION_TOOL: ToolContent = {
  slug: 'annotate-pdf', task: 'annotate', title: 'Annotate a PDF online',
  description: 'Highlight text, add comments and mark up PDF pages in your browser. Free local-first annotation without an account.',
  intro: 'Review a document with highlights, notes and drawing tools, then download the annotated PDF. Ordinary annotations are processed on your device.',
  cta: 'Open a PDF to annotate',
  steps: [
    { title: 'Open the document to review', text: 'Choose a PDF from your device. Read the page and find the text or area you want to mark.' },
    { title: 'Add your annotations', text: 'Choose Comment for notes and markup tools. Select text to highlight it, or add a note or drawing where you need feedback.' },
    { title: 'Save an annotated copy', text: 'Review your marks and comments, then choose Download copy. Keep the original if you also need a clean version.' },
  ],
  limits: [
    'Text highlighting needs a selectable text layer. Scanned pages can be marked with drawing tools, but web OCR is not available.',
    'Annotations are not secure redaction. Covering text with a shape does not guarantee that the original content is removed.',
  ],
  faq: [
    { question: 'Can I annotate a PDF without an account?', answer: 'Yes. Highlights, notes, drawing tools and downloading an annotated PDF are free without signing in.' },
    { question: 'Can I highlight text in a scanned PDF?', answer: 'A scanned image has no selectable words unless it already includes an OCR text layer. Use drawing tools for visual marks; the web editor does not perform OCR.' },
    { question: 'Are my comments saved in the downloaded PDF?', answer: 'Use Download copy to save your current annotations with the PDF. Review the result in your PDF reader before sharing it.' },
  ],
};
export function toolsForLocale(locale: UiLocale): readonly ToolContent[] {
  return ['en', 'de', 'fr'].includes(locale) ? [...TOOLS, ANNOTATION_TOOL] : TOOLS;
}
export function getTool(slug: string, locale: UiLocale = 'en') { return toolsForLocale(locale).find(tool => tool.slug === slug); }
export const TOOL_SHARED_COPY = {
  title: 'Free PDF tools',
  description: 'Edit text, organize pages and export images with local-first PDF tools. Choose a task to see the steps and open the editor.',
  steps: 'How it works', limits: 'Before you start', faq: 'Questions and answers', related: 'More PDF tools',
  local: 'Ordinary PDF editing stays on your device. No account needed.',
  webLimits: 'Web PDFs: up to 50 MiB and 200 pages per file. Up to two documents, 100 MiB and 400 pages in total.',
  back: 'Back to the guide',
} as const;
